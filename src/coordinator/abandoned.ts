import { DEFAULT_LIMITS } from "../config/config.ts";
import type { RunEntry } from "./run-history.ts";
import type { AttemptRecord, RunLog, RunResult } from "./run-log.ts";

export type RunStatus = RunResult | "abandoned";

function silentFor(lastChange: number, now: Date, idleTimeoutMs: number): boolean {
  return now.getTime() - lastChange > idleTimeoutMs;
}

export function idleTimeoutOf(log: RunLog): number {
  return log.attemptIdleTimeoutMs ?? DEFAULT_LIMITS.run.attemptIdleTimeoutMs;
}

export function attemptAbandoned(attempt: AttemptRecord, { log, logTimes }: Pick<RunEntry, "log" | "logTimes">, now: Date): boolean {
  if (attempt.outcome !== "running") return false;
  const lastChange = logTimes.get(attempt.logPath)?.getTime() ?? Date.parse(attempt.startedAt);
  return silentFor(lastChange, now, idleTimeoutOf(log));
}

export function lastChange({ modifiedAt, logTimes }: Pick<RunEntry, "modifiedAt" | "logTimes">): Date {
  return new Date(Math.max(modifiedAt.getTime(), ...[...logTimes.values()].map((time) => time.getTime())));
}

export function runAbandoned(entry: RunEntry, now: Date): boolean {
  return entry.log.result === "running" && silentFor(lastChange(entry).getTime(), now, idleTimeoutOf(entry.log));
}

export function runStatus(entry: RunEntry, now: Date): RunStatus {
  return runAbandoned(entry, now) ? "abandoned" : entry.log.result;
}

export function abandonedLogs(entries: readonly RunEntry[], now: Date): Set<RunLog> {
  return new Set(entries.filter((entry) => runAbandoned(entry, now)).map((entry) => entry.log));
}
