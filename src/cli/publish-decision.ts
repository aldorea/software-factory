import { clockMinutes } from "./clock-time.ts";
import { lastChange, runAbandoned } from "../coordinator/abandoned.ts";
import type { RunEntry } from "../coordinator/run-history.ts";

export type PublishDecision = { kind: "publish" } | { kind: "refuse"; reason: string };

export function publishDecision(entry: RunEntry, now: Date): PublishDecision {
  const { log } = entry;
  if (runAbandoned(entry, now)) {
    return {
      kind: "refuse",
      reason: `run ${log.runId} of #${log.issue} was abandoned at ${clockMinutes(lastChange(entry))}; factory run starts a new run`,
    };
  }
  if (log.result === "running") {
    return { kind: "refuse", reason: `run ${log.runId} of #${log.issue} is still running; publish it when it ends` };
  }
  return { kind: "publish" };
}
