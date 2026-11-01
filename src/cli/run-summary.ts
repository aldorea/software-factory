import type { RunLog, SubtaskRecord } from "../coordinator/run-log.ts";
import { notPublishedMessage } from "../coordinator/publication.ts";
import { countedTokens, formatDuration } from "../coordinator/stop-rules.ts";
import { strong } from "./setup-render.ts";

const RED = 91;

export function runSummary(log: RunLog, issueTitle: string, color: boolean): string[] {
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
    ...publicationLine(log, issueTitle, color),
  ];
}

function publicationLine(log: RunLog, issueTitle: string, color: boolean): string[] {
  if (log.publicationFailure !== undefined) return [strong(RED, notPublishedMessage(issueTitle, log.issue), color)];
  return log.pullRequest !== undefined ? [`Pull request: ${log.pullRequest.url}`] : [];
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
