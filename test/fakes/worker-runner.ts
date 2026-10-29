import { existsSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
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
  ActivityEvent,
  AgentSpec,
  AttemptHooks,
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
  activity?: ActivityEvent[];
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

export type AttemptScript = (call: AttemptCall) => ScriptedAttempt | Promise<ScriptedAttempt>;

export interface TesterCall extends AttemptCall {
  criteria: string[];
  evidenceDir: string;
}

export interface ScriptedTesterAttempt {
  evidence?: Record<string, string>;
  links?: Record<string, string>;
  outcome?: AttemptOutcome;
  usage?: Partial<TokenUsage>;
}

export type TesterScript = (call: TesterCall) => ScriptedTesterAttempt | Promise<ScriptedTesterAttempt>;

export interface ReportedVerdict {
  id: string;
  verdict: "pass" | "fail";
  observation: string;
  evidence: string[];
}

export function testerReport(verdicts: ReportedVerdict[]): AttemptOutcome {
  return { kind: "completed", summary: `I used the app.\n\n\`\`\`json\n${JSON.stringify({ criteria: verdicts })}\n\`\`\`` };
}

export const passingTester: TesterScript = ({ criteria }) => ({
  evidence: Object.fromEntries(criteria.map((id) => [`${id}/steps.txt`, `curl the app for ${id}\n200 OK\n`])),
  outcome: testerReport(
    criteria.map((id) => ({ id, verdict: "pass", observation: `The app did what ${id} says.`, evidence: [`${id}/steps.txt`] })),
  ),
});

export interface WorkerFaults {
  start?: (spec: WorkerSpec) => Error | undefined;
  attempt?: (call: AttemptCall) => Error | undefined;
  close?: (spec: WorkerSpec) => Error | undefined;
}

export class FakeWorkerRunner implements WorkerRunner {
  readonly workers: FakeWorkerRecord[] = [];

  private readonly script: AttemptScript;
  private readonly faults: WorkerFaults;

  private readonly tester: TesterScript;

  constructor(script: AttemptScript = () => ({}), faults: WorkerFaults = {}, tester: TesterScript = passingTester) {
    this.script = script;
    this.faults = faults;
    this.tester = tester;
  }

  async start(spec: WorkerSpec): Promise<Worker> {
    const startFault = this.faults.start?.(spec);
    if (startFault) throw startFault;
    const worktreePath = await prepareWorktree(spec);
    const record: FakeWorkerRecord = { spec, worktreePath, attempts: [], execs: [], closed: false };
    this.workers.push(record);
    return new FakeWorker(record, await mergeBase(spec.repoDir, spec.baseRef, spec.branch), this.script, this.faults, this.tester);
  }
}

class FakeWorker implements Worker {
  private readonly record: FakeWorkerRecord;
  private readonly baseSha: string;
  private readonly script: AttemptScript;
  private readonly faults: WorkerFaults;
  private readonly tester: TesterScript;

  constructor(record: FakeWorkerRecord, baseSha: string, script: AttemptScript, faults: WorkerFaults, tester: TesterScript) {
    this.record = record;
    this.baseSha = baseSha;
    this.script = script;
    this.faults = faults;
    this.tester = tester;
  }

  get spec(): WorkerSpec {
    return this.record.spec;
  }

  get worktreePath(): string {
    return this.record.worktreePath;
  }

  async attempt(agent: AgentSpec, prompt: string, limits: AttemptLimits, hooks?: AttemptHooks): Promise<AttemptResult> {
    const call: AttemptCall = { spec: this.spec, agent, prompt, limits, number: this.record.attempts.length + 1 };
    this.record.attempts.push(call);
    const logPath = join(this.spec.logDir, `${this.spec.id}-attempt-${call.number}.jsonl`);
    const startedAt = new Date();
    await mkdir(this.spec.logDir, { recursive: true });
    await writeFile(logPath, "");
    await hooks?.onStart?.({ logPath, startedAt });
    const attemptFault = this.faults.attempt?.(call);
    if (attemptFault) throw attemptFault;
    if (this.spec.outputDir !== undefined) return this.test(call, this.spec.outputDir, startedAt, logPath);
    const scripted = await this.script(call);
    for (const event of scripted.activity ?? []) hooks?.onActivity?.(event);
    for (const [path, content] of Object.entries(scripted.files ?? {})) {
      await mkdir(dirname(join(this.worktreePath, path)), { recursive: true });
      await writeFile(join(this.worktreePath, path), content);
    }
    if (scripted.files && !(await isClean(this.worktreePath))) {
      await execOk("git", ["-C", this.worktreePath, "add", "-A"]);
      await execOk("git", ["-C", this.worktreePath, "commit", "-q", "-m", scripted.commit ?? `Work on ${this.spec.id}`]);
    }
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

  private async test(call: AttemptCall, evidenceDir: string, startedAt: Date, logPath: string): Promise<AttemptResult> {
    const criteria = [...call.prompt.matchAll(/^- (A[0-9]+) \(/gm)].map((match) => match[1] as string);
    const scripted = await this.tester({ ...call, criteria, evidenceDir });
    for (const [path, content] of Object.entries(scripted.evidence ?? {})) {
      await mkdir(dirname(join(evidenceDir, path)), { recursive: true });
      await writeFile(join(evidenceDir, path), content);
    }
    for (const [path, target] of Object.entries(scripted.links ?? {})) {
      await mkdir(dirname(join(evidenceDir, path)), { recursive: true });
      await symlink(target, join(evidenceDir, path));
    }
    await writeFile(logPath, `${JSON.stringify({ type: "fake-tester", number: call.number })}\n`);
    return {
      outcome: scripted.outcome ?? { kind: "completed", summary: "done" },
      usage: { ...emptyUsage(), ...scripted.usage },
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
    const clean = await isClean(this.worktreePath);
    if (clean) await removeWorktree(this.spec.repoDir, this.worktreePath);
    const closeFault = this.faults.close?.(this.spec);
    if (closeFault) throw closeFault;
    return clean ? {} : { preservedWorktreePath: this.worktreePath };
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
