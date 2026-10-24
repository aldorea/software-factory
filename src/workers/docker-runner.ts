import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyClaudeLine,
  claudeCodeArgs,
  claudeOutcome,
  initialClaudeState,
  isClaudeFinalLine,
} from "./claude-code.ts";
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
import { applyOpenCodeLine, initialOpenCodeState, openCodeArgs, openCodeOutcome } from "./opencode.ts";
import { exec, execOk } from "./sh.ts";
import { supervise } from "./supervise.ts";
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

  constructor(
    readonly spec: WorkerSpec,
    readonly worktreePath: string,
    private readonly baseSha: string,
    private readonly container: string,
    private readonly secretsDir: string,
  ) {}

  async attempt(agent: AgentSpec, prompt: string, limits: AttemptLimits): Promise<AttemptResult> {
    this.attempts += 1;
    const logPath = join(this.spec.logDir, `${this.spec.id}-attempt-${this.attempts}.jsonl`);
    const startedAt = new Date();
    const dockerExec = (args: string[]) => ["exec", "-i", this.container, ...args];
    const terminate = (pattern: string) => async () => {
      await exec("docker", ["exec", this.container, "pkill", "-KILL", "-f", pattern]);
    };

    if (agent.kind === "claude-code") {
      let state = initialClaudeState();
      const supervised = await supervise({
        command: "docker",
        args: dockerExec(claudeCodeArgs(agent.model)),
        stdin: prompt,
        logPath,
        deadline: limits.deadline,
        idleTimeoutMs: limits.idleTimeoutMs,
        onLine: (line) => {
          state = applyClaudeLine(state, line);
        },
        isFinalLine: isClaudeFinalLine,
        terminate: terminate("claude"),
      });
      return {
        outcome: claudeOutcome(state, supervised),
        usage: state.usage,
        ...(state.plan ? { plan: state.plan } : {}),
        logPath,
        startedAt,
        endedAt: new Date(),
      };
    }

    let state = initialOpenCodeState();
    const supervised = await supervise({
      command: "docker",
      args: dockerExec(openCodeArgs(agent.model)),
      stdin: prompt,
      logPath,
      deadline: limits.deadline,
      idleTimeoutMs: limits.idleTimeoutMs,
      onLine: (line) => {
        state = applyOpenCodeLine(state, line);
      },
      terminate: terminate("opencode"),
    });
    return {
      outcome: openCodeOutcome(state, supervised),
      usage: { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 },
      logPath,
      startedAt,
      endedAt: new Date(),
    };
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
