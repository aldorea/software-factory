import type { Subtask } from "../spec/spec.ts";
import type { CheckRecord, CriterionRecord, SubtaskState } from "./run-log.ts";
import { stopReason, type StopLimits, type StopReason } from "./stop-rules.ts";

export interface FollowUpTask {
  subtask: Subtask;
  criteria: string[];
}

export function followUpTasks(
  subtasks: Subtask[],
  criteria: CriterionRecord[],
  stateOf: (subtaskId: string) => SubtaskState,
): FollowUpTask[] {
  const tasks = new Map<string, FollowUpTask>();
  for (const criterion of criteria) {
    if (criterion.passed) continue;
    const owner = subtasks.find((subtask) => subtask.criteria.includes(criterion.id));
    if (owner === undefined || stateOf(owner.id) !== "merged") continue;
    const task = tasks.get(owner.id) ?? { subtask: owner, criteria: [] };
    task.criteria.push(criterion.id);
    tasks.set(owner.id, task);
  }
  return [...tasks.values()];
}

export function verificationSignature(criteria: CriterionRecord[]): string {
  return criteria
    .filter((criterion) => !criterion.passed)
    .map((criterion) => `criterion:${criterion.id}`)
    .sort()
    .join(" | ");
}

export interface FollowUpProgress {
  signatures: string[];
  runElapsedMs: number;
  runTokens: number;
}

export function followUpStop(progress: FollowUpProgress, limits: StopLimits): StopReason | null {
  return stopReason({ ...progress, subtaskElapsedMs: 0, subtaskTokens: 0 }, limits);
}

export function followUpFailure(
  sha: string,
  task: FollowUpTask,
  verification: { checks: CheckRecord[]; criteria: CriterionRecord[] },
  texts: Record<string, string>,
): string {
  const owned = new Set(task.criteria);
  const lines = verification.criteria
    .filter((criterion) => owned.has(criterion.id))
    .map(
      (criterion) =>
        `- criterion ${criterion.id} (${criterion.evidence}) failed with exit code ${criterion.exitCode}. Criterion: ${texts[criterion.id] ?? criterion.id}. Command: \`${criterion.command}\``,
    );
  const checks = verification.checks
    .filter((check) => !check.passed)
    .map(
      (check) =>
        `- check ${check.name} failed with exit code ${check.exitCode}${check.firstError ? `: ${check.firstError}` : ""}. Command: \`${check.command}\``,
    );
  const failed = [...lines, ...(checks.length > 0 ? ["", "These checks of the repo failed in the same run:", ...checks] : [])];
  return `The integrated verification on ${sha.slice(0, 12)} failed:\n\n${failed.join("\n")}`;
}
