import type { AgentKind } from "../workers/types.ts";
import type { RunLog } from "./run-log.ts";

export const CLEAN_RUNS_TO_GO_UP = 3;

export const MAX_PARALLEL_CEILING = 2;

export interface ParallelismBounds {
  start: number;
  ceiling: number;
}

export function adjustMaxParallel(history: readonly RunLog[], agent: AgentKind, bounds: ParallelismBounds): number {
  const ceiling = Math.min(MAX_PARALLEL_CEILING, Math.max(1, bounds.ceiling));
  let value = clamp(bounds.start, ceiling);
  let cleanRuns = 0;
  const ordered = [...history].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  for (const run of ordered) {
    const pauses = (run.pauses ?? []).filter((pause) => pause.agent === agent).length;
    if (pauses > 0) {
      value = clamp(value - pauses, ceiling);
      cleanRuns = 0;
    } else if (run.agents.workers.agent === agent && run.result !== "running") {
      if (run.workerLayerFailures.length > 0) cleanRuns = 0;
      else cleanRuns += 1;
      if (cleanRuns === CLEAN_RUNS_TO_GO_UP) {
        value = clamp(value + 1, ceiling);
        cleanRuns = 0;
      }
    }
  }
  return value;
}

function clamp(value: number, ceiling: number): number {
  return Math.min(ceiling, Math.max(1, value));
}
