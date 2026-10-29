import type { RunEntry } from "./run-history.ts";
import type { AttemptRecord, RunLog, RunResult } from "./run-log.ts";

export type RunStatus = RunResult | "abandoned";

function silentFor(lastChange: number, now: Date, idleTimeoutMs: number): boolean {
  return now.getTime() - lastChange > idleTimeoutMs;
}

export function attemptAbandoned(
  attempt: AttemptRecord,
  logTimes: ReadonlyMap<string, Date>,
  now: Date,
  idleTimeoutMs: number,
): boolean {
  if (attempt.outcome !== "running") return false;
  const lastChange = logTimes.get(attempt.logPath)?.getTime() ?? Date.parse(attempt.startedAt);
  return silentFor(lastChange, now, idleTimeoutMs);
}

export function lastChange({ modifiedAt, logTimes }: Pick<RunEntry, "modifiedAt" | "logTimes">): Date {
  return new Date(Math.max(modifiedAt.getTime(), ...[...logTimes.values()].map((time) => time.getTime())));
}

export function runAbandoned(entry: RunEntry, now: Date, idleTimeoutMs: number): boolean {
  return entry.log.result === "running" && silentFor(lastChange(entry).getTime(), now, idleTimeoutMs);
}

export function runStatus(entry: RunEntry, now: Date, idleTimeoutMs: number): RunStatus {
  return runAbandoned(entry, now, idleTimeoutMs) ? "abandoned" : entry.log.result;
}

export function abandonedLogs(entries: readonly RunEntry[], now: Date, idleTimeoutMs: number): Set<RunLog> {
  return new Set(entries.filter((entry) => runAbandoned(entry, now, idleTimeoutMs)).map((entry) => entry.log));
}
