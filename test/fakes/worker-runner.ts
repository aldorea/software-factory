import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { emptyUsage } from "../../src/workers/agent-adapter.ts";
import {
  addWorktree,
  addWorktreeForBranch,
  branchExists,
  commitsSince,
  isClean,
  listWorktrees,
  mergeBase,
  removeWorktree,
  revParse,
} from "../../src/workers/git.ts";
import { exec, execOk } from "../../src/workers/sh.ts";
import type {
  AgentSpec,
  AttemptLimits,
  AttemptOutcome,
  AttemptResult,
  CloseResult,
  ExecResult,
  PlanStatus,
  TokenUsage,
  Worker,
  WorkerRunner,
  WorkerSpec,
} from "../../src/workers/types.ts";

export interface ScriptedAttempt {
  files?: Record<string, string>;
  commit?: string;
  outcome?: AttemptOutcome;
  usage?: Partial<TokenUsage>;
  plan?: PlanStatus;
}

export interface AttemptCall {
  spec: WorkerSpec;
  agent: AgentSpec;
  prompt: string;
  limits: AttemptLimits;
  number: number;
}

export interface ExecCall {
  command: string;
  exitCode: number;
}

export interface FakeWorkerRecord {
  spec: WorkerSpec;
  worktreePath: string;
  attempts: AttemptCall[];
  execs: ExecCall[];
  closed: boolean;
}

export type AttemptScript = (call: AttemptCall) => ScriptedAttempt;

export class FakeWorkerRunner implements WorkerRunner {
  readonly workers: FakeWorkerRecord[] = [];

  constructor(private readonly script: AttemptScript = () => ({})) {}

  async start(spec: WorkerSpec): Promise<Worker> {
    const worktreePath = await prepareWorktree(spec);
    const record: FakeWorkerRecord = { spec, worktreePath, attempts: [], execs: [], closed: false };
    this.workers.push(record);
    return new FakeWorker(record, await mergeBase(spec.repoDir, spec.baseRef, spec.branch), this.script);
  }
}

class FakeWorker implements Worker {
  constructor(
    private readonly record: FakeWorkerRecord,
    private readonly baseSha: string,
    private readonly script: AttemptScript,
  ) {}

  get spec(): WorkerSpec {
    return this.record.spec;
  }

  get worktreePath(): string {
    return this.record.worktreePath;
  }

  async attempt(agent: AgentSpec, prompt: string, limits: AttemptLimits): Promise<AttemptResult> {
    const call: AttemptCall = { spec: this.spec, agent, prompt, limits, number: this.record.attempts.length + 1 };
    this.record.attempts.push(call);
    const startedAt = new Date();
    const scripted = this.script(call);
    for (const [path, content] of Object.entries(scripted.files ?? {})) {
      await mkdir(dirname(join(this.worktreePath, path)), { recursive: true });
      await writeFile(join(this.worktreePath, path), content);
    }
    if (scripted.files && !(await isClean(this.worktreePath))) {
      await execOk("git", ["-C", this.worktreePath, "add", "-A"]);
      await execOk("git", ["-C", this.worktreePath, "commit", "-q", "-m", scripted.commit ?? `Work on ${this.spec.id}`]);
    }
    const logPath = join(this.spec.logDir, `${this.spec.id}-attempt-${call.number}.jsonl`);
    await mkdir(this.spec.logDir, { recursive: true });
    await writeFile(logPath, `${JSON.stringify({ type: "fake-attempt", number: call.number })}\n`);
    return {
      outcome: scripted.outcome ?? { kind: "completed", summary: "done" },
      usage: { ...emptyUsage(), ...scripted.usage },
      ...(scripted.plan ? { plan: scripted.plan } : {}),
      logPath,
      startedAt,
      endedAt: new Date(),
    };
  }

  async exec(command: string, options: { timeoutMs?: number } = {}): Promise<ExecResult> {
    const result = await exec("sh", ["-c", command], { cwd: this.worktreePath, ...options });
    this.record.execs.push({ command, exitCode: result.exitCode });
    return result;
  }

  commits(): Promise<string[]> {
    return commitsSince(this.spec.repoDir, this.baseSha, this.spec.branch);
  }

  async close(): Promise<CloseResult> {
    this.record.closed = true;
    if (await isClean(this.worktreePath)) {
      await removeWorktree(this.spec.repoDir, this.worktreePath);
      return {};
    }
    return { preservedWorktreePath: this.worktreePath };
  }
}

async function prepareWorktree(spec: WorkerSpec): Promise<string> {
  const registered = (await listWorktrees(spec.repoDir)).find((entry) => entry.branch === spec.branch);
  if (registered) return registered.path;
  const worktreePath = join(spec.repoDir, ".factory", "worktrees", spec.id);
  if (existsSync(worktreePath)) throw new Error(`${worktreePath} exists but is not a worktree of ${spec.branch}`);
  if (await branchExists(spec.repoDir, spec.branch)) {
    await addWorktreeForBranch(spec.repoDir, worktreePath, spec.branch);
  } else {
    await addWorktree(spec.repoDir, worktreePath, spec.branch, await revParse(spec.repoDir, spec.baseRef));
  }
  return worktreePath;
}
