import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AttemptRecord, RunLog, SubtaskRecord, TesterPhase, TesterVerdictRecord, VerificationRecord, VerifierRecord } from "../../src/coordinator/run-log.ts";
import { writeRunLog } from "../../src/coordinator/run-log.ts";
import { emptyUsage } from "../../src/workers/agent-adapter.ts";
import type { AgentKind, TokenUsage } from "../../src/workers/types.ts";
import { runRecord, subtaskRecord } from "../coordinator/run-log-fixtures.ts";
import { NOW } from "./web-helpers.ts";

const REAL_LOGS = join(dirname(fileURLToPath(import.meta.url)), "..", "workers", "fixtures");

export async function realLog(name: string): Promise<string[]> {
  return (await readFile(join(REAL_LOGS, name), "utf8")).split("\n").filter((line) => line.trim() !== "");
}

export function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

export interface AttemptFixture {
  subtask: string;
  number?: number;
  agent?: AgentKind;
  model?: string;
  outcome?: AttemptRecord["outcome"];
  lines?: string[];
  startedAgoMs?: number;
  silentMs?: number;
  durationMs?: number;
  usage?: Partial<TokenUsage>;
}

export interface RoleFixture {
  agent?: AgentKind;
  model?: string;
  lines?: string[];
  startedAgoMs?: number;
  silentMs?: number;
}

export interface VerifierQuestionFixture extends RoleFixture {
  subtask: string;
  criterion: string;
}

export interface EndedVerifierFixture {
  subtask: string;
  criterion: string;
  verdict: VerifierRecord["verdict"];
  startedAgoMs: number;
  durationMs: number;
}

export interface TesterFixture extends RoleFixture {
  phase?: TesterPhase;
  verdicts?: Array<Pick<TesterVerdictRecord, "id" | "passed">>;
  error?: string;
  durationMs?: number;
  usage?: Partial<TokenUsage>;
}

export interface LiveRunFixture {
  issue?: number;
  integrationBranch?: string;
  attemptIdleTimeoutMs?: number;
  runJsonSilentMs?: number;
  startedAgoMs?: number;
  result?: RunLog["result"];
  attempts: AttemptFixture[];
  verifierQuestions?: VerifierQuestionFixture[];
  endedVerifiers?: EndedVerifierFixture[];
  tester?: TesterFixture;
}

export interface LiveRun {
  runId: string;
  runDir: string;
  log: RunLog;
}

function attemptRecordOf(fixture: AttemptFixture, logPath: string): AttemptRecord {
  const number = fixture.number ?? 1;
  const startedAt = ago(fixture.startedAgoMs ?? 5 * 60_000);
  const outcome = fixture.outcome ?? "running";
  return {
    number,
    agent: { agent: fixture.agent ?? "claude-code", model: fixture.model ?? "claude-sonnet-5-5" },
    outcome,
    usage: { ...emptyUsage(), ...fixture.usage },
    logPath,
    startedAt: startedAt.toISOString(),
    ...(outcome === "running" ? {} : { endedAt: new Date(startedAt.getTime() + (fixture.durationMs ?? 60_000)).toISOString() }),
  };
}

export async function writeLiveRun(logsDir: string, fixture: LiveRunFixture): Promise<LiveRun> {
  const issue = fixture.issue ?? 23;
  const startedAt = ago(fixture.startedAgoMs ?? 30 * 60_000);
  const runId = `${issue}-${startedAt.toISOString().replace(/[:.]/g, "-")}`;
  const runDir = join(logsDir, runId);
  await mkdir(runDir, { recursive: true });
  const subtasks = new Map<string, SubtaskRecord>();
  const times: Array<[string, Date]> = [];
  for (const attempt of fixture.attempts) {
    const logPath = join(runDir, `${attempt.subtask}-attempt-${attempt.number ?? 1}.jsonl`);
    await writeFile(logPath, (attempt.lines ?? []).map((line) => `${line}\n`).join(""));
    times.push([logPath, ago(attempt.silentMs ?? 0)]);
    const subtask = subtasks.get(attempt.subtask) ?? subtaskRecord(attempt.subtask, { state: "working" });
    subtask.attempts.push(attemptRecordOf(attempt, logPath));
    subtasks.set(attempt.subtask, subtask);
  }
  const subtaskOf = (id: string): SubtaskRecord => {
    const subtask = subtasks.get(id) ?? subtaskRecord(id, { state: "gating" });
    subtasks.set(id, subtask);
    return subtask;
  };
  for (const question of fixture.verifierQuestions ?? []) {
    const logPath = join(runDir, `${question.subtask}-attempt-1-verifier-${question.criterion}.jsonl`);
    await writeFile(logPath, (question.lines ?? []).map((line) => `${line}\n`).join(""));
    times.push([logPath, ago(question.silentMs ?? 0)]);
    Object.assign(subtaskOf(question.subtask), { state: "gating" }).verifierQuestion = { id: question.criterion, logPath, startedAt: ago(question.startedAgoMs ?? 60_000).toISOString() };
  }
  for (const ended of fixture.endedVerifiers ?? []) {
    const subtask = subtaskOf(ended.subtask);
    const startedAt = ago(ended.startedAgoMs);
    const record: VerifierRecord = {
      id: ended.criterion,
      verdict: ended.verdict,
      logPath: join(runDir, `${ended.subtask}-attempt-1-verifier-${ended.criterion}.jsonl`),
      startedAt: startedAt.toISOString(),
      endedAt: new Date(startedAt.getTime() + ended.durationMs).toISOString(),
    };
    subtask.gate = { sha: "abc123", accepted: true, reasons: [], checks: [], criteria: [], verifier: [...(subtask.gate?.verifier ?? []), record] };
  }
  const tester = fixture.tester === undefined ? undefined : await testerVerification(runDir, fixture.tester, times);
  const { endedAt: _endedAt, ...base } = runRecord(0, [...subtasks.values()], {
    issue,
    runId,
    result: fixture.result ?? "running",
    integrationBranch: fixture.integrationBranch ?? `factory/${issue}-health-endpoint`,
  });
  const log: RunLog = {
    ...base,
    startedAt: startedAt.toISOString(),
    ...(fixture.attemptIdleTimeoutMs !== undefined ? { attemptIdleTimeoutMs: fixture.attemptIdleTimeoutMs } : {}),
    ...(tester === undefined ? {} : { verification: tester.verification, testerUsage: tester.usage }),
    agents: {
      ...base.agents,
      ...(tester === undefined ? {} : { tester: tester.agent }),
      ...(fixture.verifierQuestions === undefined && fixture.endedVerifiers === undefined
        ? {}
        : { verifier: { agent: fixture.verifierQuestions?.[0]?.agent ?? "opencode", model: fixture.verifierQuestions?.[0]?.model ?? "opencode-go/glm-5.1" } }),
    },
  };
  const runJson = join(runDir, "run.json");
  await writeRunLog(runJson, log);
  const runJsonAt = ago(fixture.runJsonSilentMs ?? 0);
  await utimes(runJson, runJsonAt, runJsonAt);
  for (const [path, at] of times) await utimes(path, at, at);
  return { runId, runDir, log };
}

async function testerVerification(
  runDir: string,
  fixture: TesterFixture,
  times: Array<[string, Date]>,
): Promise<{ verification: VerificationRecord; agent: { agent: AgentKind; model: string }; usage: Partial<Record<AgentKind, TokenUsage>> }> {
  const agent = { agent: fixture.agent ?? "opencode", model: fixture.model ?? "opencode-go/glm-5.1" };
  const startedAt = ago(fixture.startedAgoMs ?? 3 * 60_000);
  const logPath = join(runDir, "verification-tester-attempt-1.jsonl");
  const usage = { [agent.agent]: { ...emptyUsage(), ...fixture.usage } };
  const base = { sha: "def456", passed: true, checks: [], criteria: [], humanCriteria: [] };
  if (fixture.verdicts !== undefined || fixture.error !== undefined) {
    const tester = {
      agent: { agent: agent.agent, model: agent.model },
      verdicts: (fixture.verdicts ?? []).map((verdict) => ({ ...verdict, observation: "seen", evidence: [] })),
      ...(fixture.error === undefined ? {} : { error: fixture.error }),
      logPath,
      startedAt: startedAt.toISOString(),
      endedAt: new Date(startedAt.getTime() + (fixture.durationMs ?? 60_000)).toISOString(),
    };
    return { verification: { ...base, tester }, agent, usage };
  }
  const verification: VerificationRecord = { ...base, testerPhase: fixture.phase ?? "testing", testerStartedAt: startedAt.toISOString() };
  if (fixture.lines !== undefined) {
    await writeFile(logPath, fixture.lines.map((line) => `${line}\n`).join(""));
    times.push([logPath, ago(fixture.silentMs ?? 0)]);
    verification.testerLogPath = logPath;
  }
  return { verification, agent, usage };
}
