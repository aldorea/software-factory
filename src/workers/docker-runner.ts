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
import { addWorktree, commitsSince, commonGitDir, isClean, removeWorktree, revParse } from "./git.ts";
import { applyOpenCodeLine, initialOpenCodeState, openCodeArgs, openCodeOutcome } from "./opencode.ts";
import { run, runOk } from "./sh.ts";
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
    const baseSha = await revParse(spec.repoDir, spec.baseRef);
    const worktreePath = join(spec.repoDir, ".factory", "worktrees", spec.id);
    await addWorktree(spec.repoDir, worktreePath, spec.branch, baseSha);
    const gitDir = await commonGitDir(worktreePath);
    const secretsDir = await mkdtemp(join(tmpdir(), "factory-"));
    const container = `factory-${spec.id.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;

    try {
      const envFile = join(secretsDir, "env");
      await writeFile(envFile, toEnvFile(spec.env), { mode: 0o600 });
      const mounts = ["-v", `${worktreePath}:${worktreePath}`, "-v", `${gitDir}:${gitDir}`];
      await runOk("docker", [
        "run",
        "-d",
        "--init",
        "--name",
        container,
        "--env-file",
        envFile,
        ...mounts,
        "-w",
        worktreePath,
        spec.image,
      ]);
      await rm(envFile);
    } catch (error) {
      await rm(secretsDir, { recursive: true, force: true });
      await removeWorktree(spec.repoDir, worktreePath).catch(() => undefined);
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

  async runAgent(agent: AgentSpec, prompt: string, limits: AttemptLimits): Promise<AttemptResult> {
    this.attempts += 1;
    const logPath = join(this.spec.logDir, `${this.spec.id}-attempt-${this.attempts}.jsonl`);
    const startedAt = new Date();
    const exec = (args: string[]) => ["exec", this.container, ...args];
    const terminate = (pattern: string) => async () => {
      await run("docker", exec(["pkill", "-KILL", "-f", pattern]));
    };

    if (agent.kind === "claude-code") {
      let state = initialClaudeState();
      const runResult = await supervise({
        command: "docker",
        args: exec(claudeCodeArgs(prompt, agent.model)),
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
        outcome: claudeOutcome(state, runResult),
        usage: state.usage,
        ...(state.plan ? { plan: state.plan } : {}),
        logPath,
        startedAt,
        endedAt: new Date(),
      };
    }

    let state = initialOpenCodeState();
    const runResult = await supervise({
      command: "docker",
      args: exec(openCodeArgs(prompt, agent.model)),
      logPath,
      deadline: limits.deadline,
      idleTimeoutMs: limits.idleTimeoutMs,
      onLine: (line) => {
        state = applyOpenCodeLine(state, line);
      },
      terminate: terminate("opencode"),
    });
    return {
      outcome: openCodeOutcome(state, runResult),
      usage: { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 },
      logPath,
      startedAt,
      endedAt: new Date(),
    };
  }

  exec(command: string, options: { timeoutMs?: number } = {}): Promise<ExecResult> {
    return run("docker", ["exec", this.container, "sh", "-c", command], options);
  }

  commits(): Promise<string[]> {
    return commitsSince(this.spec.repoDir, this.baseSha, this.spec.branch);
  }

  async close(): Promise<CloseResult> {
    await run("docker", ["rm", "-f", this.container]);
    await rm(this.secretsDir, { recursive: true, force: true });
    if (await isClean(this.worktreePath)) {
      await removeWorktree(this.spec.repoDir, this.worktreePath);
      return {};
    }
    return { preservedWorktreePath: this.worktreePath };
  }
}

function toEnvFile(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => {
      if (value.includes("\n")) throw new Error(`Env value of ${key} has a newline`);
      return `${key}=${value}`;
    })
    .join("\n");
}
