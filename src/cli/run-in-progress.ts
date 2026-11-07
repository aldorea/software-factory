import { idleTimeoutOf, lastChange, runAbandoned } from "../coordinator/abandoned.ts";
import type { RunEntry } from "../coordinator/run-history.ts";
import { clockMinutes } from "./clock-time.ts";

export function runInProgressRefusal(latest: RunEntry | null, now: Date): string | null {
  if (latest === null || latest.log.result !== "running" || runAbandoned(latest, now)) return null;
  const since = new Date(latest.log.startedAt);
  const abandonedAt = new Date(lastChange(latest).getTime() + idleTimeoutOf(latest.log));
  return `run ${latest.log.runId} of #${latest.log.issue} is in progress since ${clockMinutes(since)}; it counts as abandoned at ${clockMinutes(abandonedAt)}`;
}
