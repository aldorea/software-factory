import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AttemptRecord, RunLog, SubtaskRecord } from "../../src/coordinator/run-log.ts";
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

export interface LiveRunFixture {
  issue?: number;
  integrationBranch?: string;
  attemptIdleTimeoutMs?: number;
  runJsonSilentMs?: number;
  startedAgoMs?: number;
  result?: RunLog["result"];
  attempts: AttemptFixture[];
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
  };
  const runJson = join(runDir, "run.json");
  await writeRunLog(runJson, log);
  const runJsonAt = ago(fixture.runJsonSilentMs ?? 0);
  await utimes(runJson, runJsonAt, runJsonAt);
  for (const [path, at] of times) await utimes(path, at, at);
  return { runId, runDir, log };
}
