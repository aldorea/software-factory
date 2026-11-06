import type { RunEntry } from "../coordinator/run-history.ts";
import { isAtWork, liveRun, type LiveResponse, type RawLogTails } from "./live.ts";

export function runActivity(entry: RunEntry, tails: RawLogTails, now: Date): LiveResponse {
  const run = liveRun(entry, tails, now);
  const atWork = run.agents.filter(isAtWork).length;
  return { now: now.toISOString(), inProgress: atWork > 0, atWork, runs: [run] };
}
