import type { RunEntry } from "../coordinator/run-history.ts";
import { liveAnswer, liveRun, runInProgress, type LiveResponse, type RawLogTails } from "./live.ts";

export function runActivity(entry: RunEntry, tails: RawLogTails, now: Date): LiveResponse {
  return liveAnswer([liveRun(entry, tails, now)], now, runInProgress(entry, now));
}
