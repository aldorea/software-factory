import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterFor } from "./agents.ts";
import { performAttempt } from "./attempt.ts";
import {
  addWorktree,
  addWorktreeForBranch,
  branchExists,
  commitsSince,
  commonGitDir,
  isClean,
  listWorktrees,
  mergeBase,
  removeWorktree,
  revParse,
} from "./git.ts";
import { exec, execOk } from "./sh.ts";
import type {
  AgentSpec,
  AttemptLimits,
  AttemptResult,
  CloseResult,
  ExecResult,
  Worker,
  WorkerRunner,
  WorkerSpec,
} from "./types.ts";

export class DockerWorkerRunner implements WorkerRunner {
  async start(spec: WorkerSpec): Promise<Worker> {
    const container = `factory-${spec.id.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
    await exec("docker", ["rm", "-f", container]);

    const { worktreePath, created } = await prepareWorktree(spec);
    const baseSha = await mergeBase(spec.repoDir, spec.baseRef, spec.branch);
    const gitDir = await commonGitDir(worktreePath);
    const secretsDir = await mkdtemp(join(tmpdir(), "factory-"));

    try {
      const envFile = join(secretsDir, "env");
      await writeFile(envFile, toEnvFile(spec.env), { mode: 0o600 });
      const mounts = ["-v", `${worktreePath}:${worktreePath}`, "-v", `${gitDir}:${gitDir}`];
      const resources = [
        ...(spec.cpus !== undefined ? ["--cpus", spec.cpus] : []),
        ...(spec.memory !== undefined ? ["--memory", spec.memory] : []),
      ];
      const containerArgs = [
        "run",
        "-d",
        "--init",
        "--name",
        container,
        "--env-file",
        envFile,
        ...resources,
        ...mounts,
        "-w",
        worktreePath,
        spec.image,
      ];
      try {
        await startUntilVisible(containerArgs, container, worktreePath, spec.branch);
      } finally {
        await rm(envFile, { force: true });
      }
    } catch (error) {
      await exec("docker", ["rm", "-f", container]);
      await rm(secretsDir, { recursive: true, force: true });
      if (created) await removeWorktree(spec.repoDir, worktreePath).catch(() => undefined);
      throw error;
    }

    return new DockerWorker(spec, worktreePath, baseSha, container, secretsDir);
  }
}

class DockerWorker implements Worker {
  private attempts = 0;
  readonly spec: WorkerSpec;
  readonly worktreePath: string;
  private readonly baseSha: string;
  private readonly container: string;
  private readonly secretsDir: string;

  constructor(spec: WorkerSpec, worktreePath: string, baseSha: string, container: string, secretsDir: string) {
    this.spec = spec;
    this.worktreePath = worktreePath;
    this.baseSha = baseSha;
    this.container = container;
    this.secretsDir = secretsDir;
  }

  async attempt(agent: AgentSpec, prompt: string, limits: AttemptLimits): Promise<AttemptResult> {
    this.attempts += 1;
    const logPath = join(this.spec.logDir, `${this.spec.id}-attempt-${this.attempts}.jsonl`);
    return performAttempt({
      adapter: adapterFor(agent.kind),
      model: agent.model,
      prompt,
      limits,
      logPath,
      launch: (agentCommand) => ({ command: "docker", args: ["exec", "-i", this.container, ...agentCommand] }),
      stop: async (processName) => {
        await exec("docker", ["exec", this.container, "pkill", "-KILL", "-f", processName]);
      },
      exec: (command) => exec("docker", ["exec", this.container, ...command]),
    });
  }

  exec(command: string, options: { timeoutMs?: number } = {}): Promise<ExecResult> {
    return exec("docker", ["exec", this.container, "sh", "-c", command], options);
  }

  commits(): Promise<string[]> {
    return commitsSince(this.spec.repoDir, this.baseSha, this.spec.branch);
  }

  async close(): Promise<CloseResult> {
    await exec("docker", ["rm", "-f", this.container]);
    await rm(this.secretsDir, { recursive: true, force: true });
    if (await isClean(this.worktreePath)) {
      await removeWorktree(this.spec.repoDir, this.worktreePath);
      return {};
    }
    return { preservedWorktreePath: this.worktreePath };
  }
}

const MOUNT_VISIBLE_TIMEOUT_MS = 15_000;

async function startUntilVisible(
  containerArgs: string[],
  container: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  const deadline = Date.now() + MOUNT_VISIBLE_TIMEOUT_MS;
  let last = "";
  while (Date.now() < deadline) {
    await execOk("docker", containerArgs);
    const head = await exec("docker", ["exec", container, "git", "-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"]);
    if (head.exitCode === 0 && head.stdout.trim() === branch) return;
    last = head.stderr.trim() || head.stdout.trim();
    await exec("docker", ["rm", "-f", container]);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`The container does not see ${worktreePath} on ${branch}: ${last}`);
}

async function prepareWorktree(spec: WorkerSpec): Promise<{ worktreePath: string; created: boolean }> {
  const registered = (await listWorktrees(spec.repoDir)).find((entry) => entry.branch === spec.branch);
  if (registered) return { worktreePath: registered.path, created: false };

  const worktreePath = join(spec.repoDir, ".factory", "worktrees", spec.id);
  if (existsSync(worktreePath)) {
    throw new Error(
      `${worktreePath} exists but git does not know it as a worktree of ${spec.branch}. Check its content and remove it by hand.`,
    );
  }

  if (await branchExists(spec.repoDir, spec.branch)) {
    await addWorktreeForBranch(spec.repoDir, worktreePath, spec.branch);
  } else {
    await addWorktree(spec.repoDir, worktreePath, spec.branch, await revParse(spec.repoDir, spec.baseRef));
  }
  return { worktreePath, created: true };
}

export function toEnvFile(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => {
      if (value.includes("\n")) throw new Error(`Env value of ${key} has a newline`);
      return `${key}=${value}`;
    })
    .join("\n");
}
