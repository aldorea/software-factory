import type { RunLog, SubtaskRecord } from "../coordinator/run-log.ts";
import { countedTokens, formatDuration } from "../coordinator/stop-rules.ts";

export function runSummary(log: RunLog): string[] {
  const merged = ids(log.subtasks.filter((record) => record.state === "merged"));
  const blocked = log.subtasks.filter((record) => record.state === "blocked").map(blockedLabel);
  const unfinished = ids(log.subtasks.filter((record) => record.state !== "merged" && record.state !== "blocked"));
  const paused = log.cost.pausedMs > 0 ? ` (${formatDuration(log.cost.pausedMs)} in pause not counted)` : "";
  return [
    `Run ${log.runId}: ${log.result}${pauseSuffix(log)}`,
    `Merged: ${merged}`,
    `Blocked: ${blocked.length > 0 ? blocked.join(", ") : "none"}`,
    ...(log.result !== "ready" && unfinished !== "none" ? [`Unfinished: ${unfinished}`] : []),
    ...(log.block !== undefined ? [`Run block: ${log.block.type}`] : []),
    `Wall clock: ${formatDuration(log.cost.wallClockMs)}${paused}`,
    `Tokens: ${countedTokens(log.cost.usage)}`,
    ...(log.pullRequest !== undefined ? [`Pull request: ${log.pullRequest.url}`] : []),
  ];
}

function ids(records: readonly SubtaskRecord[]): string {
  return records.length > 0 ? records.map((record) => record.id).join(", ") : "none";
}

function blockedLabel(record: SubtaskRecord): string {
  return record.blockType === undefined ? record.id : `${record.id} (${record.blockType})`;
}

function pauseSuffix(log: RunLog): string {
  if (log.result !== "paused") return "";
  return log.resetsAt === undefined ? "" : ` until the plan limit resets at ${log.resetsAt}`;
}
