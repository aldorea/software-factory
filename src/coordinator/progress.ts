import type { AttemptRecord, RunLog, SubtaskRecord } from "./run-log.ts";

export function progressLines(before: RunLog | null, after: RunLog): string[] {
  if (before === null) return [startLine(after)];
  const previous = new Map(before.subtasks.map((record) => [record.id, record]));
  const lines = after.subtasks.flatMap((record) => subtaskLines(previous.get(record.id), record));
  if (after.verification !== undefined && after.verification.sha !== before.verification?.sha) {
    lines.push(`integrated verification at ${after.verification.sha.slice(0, 12)}: ${after.verification.passed ? "passed" : "failed"}`);
  }
  if (after.pauseReason !== undefined && before.pauseReason === undefined) lines.push(`run paused: ${after.pauseReason}`);
  if (after.result !== before.result) lines.push(`run ${after.runId}: ${after.result}`);
  if (after.pullRequest !== undefined && after.pullRequest.url !== before.pullRequest?.url) {
    lines.push(`pull request: ${after.pullRequest.url}`);
  }
  return lines;
}

function startLine(log: RunLog): string {
  const { agent, model } = log.agents.workers;
  const count = log.subtasks.length;
  return `run ${log.runId}: ${count} ${count === 1 ? "subtask" : "subtasks"}, workers on ${agent} ${model}`;
}

function subtaskLines(before: SubtaskRecord | undefined, after: SubtaskRecord): string[] {
  const attempts = after.attempts.slice(before?.attempts.length ?? 0).map((attempt) => attemptLine(after.id, attempt));
  if (after.state === before?.state) return attempts;
  return [...attempts, `${after.id}: ${after.state}${after.state === "blocked" && after.blockType ? ` (${after.blockType})` : ""}`];
}

function attemptLine(subtask: string, attempt: AttemptRecord): string {
  const failure = attempt.failure === undefined ? "" : `: ${attempt.failure.signature}`;
  return `${subtask}: attempt ${attempt.number} ${attempt.outcome}${failure}`;
}
