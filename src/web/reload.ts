import type { RunLog } from "../coordinator/run-log.ts";

export const RELOAD_SECONDS = 5;

export function shouldReload(logs: RunLog[]): boolean {
  return logs.some((log) => log.result === "running");
}
