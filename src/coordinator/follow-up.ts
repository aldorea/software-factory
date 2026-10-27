import type { Subtask } from "../spec/spec.ts";
import { outputSection } from "./failures.ts";
import type { CheckRecord, CriterionRecord, RunBlockRecord, SubtaskState, TesterRecord } from "./run-log.ts";
import { stopReason, type StopLimits, type StopReason } from "./stop-rules.ts";

export interface FollowUpTask {
  subtask: Subtask;
  criteria: string[];
}

export interface VerificationFailure {
  id: string;
  by: "command" | "tester";
}

export function verificationFailures(criteria: CriterionRecord[], tester?: TesterRecord): VerificationFailure[] {
  return [
    ...criteria.filter((criterion) => !criterion.passed).map((criterion) => ({ id: criterion.id, by: "command" as const })),
    ...(tester?.verdicts ?? []).filter((verdict) => !verdict.passed).map((verdict) => ({ id: verdict.id, by: "tester" as const })),
  ];
}

export function followUpTasks(
  subtasks: Subtask[],
  failures: VerificationFailure[],
  stateOf: (subtaskId: string) => SubtaskState,
): FollowUpTask[] {
  const tasks = new Map<string, FollowUpTask>();
  for (const failure of failures) {
    const owner = subtasks.find((subtask) => subtask.criteria.includes(failure.id));
    if (owner === undefined || stateOf(owner.id) !== "merged") continue;
    const task = tasks.get(owner.id) ?? { subtask: owner, criteria: [] };
    if (!task.criteria.includes(failure.id)) task.criteria.push(failure.id);
    tasks.set(owner.id, task);
  }
  return [...tasks.values()];
}

export function verificationSignature(failures: VerificationFailure[]): string {
  return failures
    .map((failure) => `${failure.by === "command" ? "criterion" : "tester"}:${failure.id}`)
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
  verification: { checks: CheckRecord[]; criteria: CriterionRecord[]; tester?: TesterRecord },
  texts: Record<string, string>,
  evidenceTails: Record<string, string> = {},
): string {
  const owned = new Set(task.criteria);
  const criteria = verification.criteria.filter((criterion) => owned.has(criterion.id) && !criterion.passed);
  const rejected = (verification.tester?.verdicts ?? []).filter((verdict) => owned.has(verdict.id) && !verdict.passed);
  const evidenceOf = new Map(verification.criteria.map((criterion) => [criterion.id, criterion.evidence]));
  const lines = criteria.map(
    (criterion) =>
      `- criterion ${criterion.id} (${criterion.evidence}) failed with exit code ${criterion.exitCode}. Criterion: ${texts[criterion.id] ?? criterion.id}. Command: \`${criterion.command}\``,
  );
  const testerLines = rejected.map(
    (verdict) =>
      `- criterion ${verdict.id} (${evidenceOf.get(verdict.id) ?? "automatic"}) passed its command, but the acceptance tester, using the running app, failed it. Criterion: ${texts[verdict.id] ?? verdict.id}. The tester saw: ${verdict.observation} Its evidence: ${verdict.evidence.map((path) => `\`${path}\``).join(", ")}`,
  );
  const failedChecks = verification.checks.filter((check) => !check.passed);
  const checks = failedChecks.map(
    (check) =>
      `- check ${check.name} failed with exit code ${check.exitCode}${check.firstError ? `: ${check.firstError}` : ""}. Command: \`${check.command}\``,
  );
  const outputs = [
    ...criteria.flatMap((criterion) =>
      criterion.outputTail !== undefined ? [outputSection(`criterion ${criterion.id}`, criterion.outputTail)] : [],
    ),
    ...failedChecks.flatMap((check) => (check.outputTail !== undefined ? [outputSection(`check ${check.name}`, check.outputTail)] : [])),
    ...rejected.flatMap((verdict) =>
      verdict.evidence.flatMap((path) => {
        const tail = evidenceTails[path];
        return tail !== undefined ? [outputSection(`the evidence \`${path}\` of the acceptance tester for ${verdict.id}`, tail)] : [];
      }),
    ),
  ];
  const failed = [...lines, ...testerLines, ...(checks.length > 0 ? ["", "These checks of the repo failed in the same run:", ...checks] : [])];
  return [`The integrated verification on ${sha.slice(0, 12)} failed:`, failed.join("\n"), ...outputs].join("\n\n");
}

export function integrationCheckBlock(sha: string, checks: CheckRecord[], criteria: CriterionRecord[]): RunBlockRecord | null {
  const failed = checks.filter((check) => !check.passed);
  if (failed.length === 0 || criteria.some((criterion) => !criterion.passed)) return null;
  const names = failed.map((check) => check.name).join(", ");
  return {
    type: "integration-check",
    reason: `The ${failed.length === 1 ? "check" : "checks"} ${names} failed on the integration branch while every criterion passed, so no subtask owns the failure.`,
    sha,
    checks: failed,
  };
}
