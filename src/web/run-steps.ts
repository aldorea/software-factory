import { runStatus } from "../coordinator/abandoned.ts";
import { MERGED_EARLIER } from "../coordinator/resume.ts";
import type { RunEntry } from "../coordinator/run-history.ts";
import type { CheckRecord, CriterionRecord, RunLog, SubtaskRecord, TesterPhase } from "../coordinator/run-log.ts";
import { safeLink } from "./safe-link.ts";

export type StepState = "passed" | "failed" | "running" | "pending" | "not-run";

export interface Tally {
  passed: number;
  total: number;
}

export type RunStep =
  | { kind: "subtask"; id: string; state: StepState; anchor: string; mergedEarlier: boolean; attempts: number; gate: "accepted" | "rejected" | null }
  | { kind: "integrated-verification"; state: StepState; anchor: string; checks: Tally; criteria: Tally }
  | { kind: "acceptance-tester"; state: StepState; anchor: string; phase: TesterPhase | null; verdicts: Tally; error: string | null }
  | { kind: "publication"; state: StepState; anchor: string; pullRequest: { number: number; url: string | null; draft: boolean } | null; failure: string | null };

function tally(records: readonly { passed: boolean }[]): Tally {
  return { passed: records.filter((record) => record.passed).length, total: records.length };
}

function waiting(active: boolean): StepState {
  return active ? "pending" : "not-run";
}

function subtaskState(subtask: SubtaskRecord, active: boolean): StepState {
  if (subtask.state === "merged") return "passed";
  if (subtask.state === "blocked") return "failed";
  if (subtask.state === "working" || subtask.state === "gating") return active ? "running" : "not-run";
  return waiting(active);
}

function subtaskStep(subtask: SubtaskRecord, active: boolean): RunStep {
  return {
    kind: "subtask",
    id: subtask.id,
    state: subtaskState(subtask, active),
    anchor: `step-subtask-${subtask.id}`,
    mergedEarlier: subtask.reason === MERGED_EARLIER,
    attempts: subtask.attempts.length,
    gate: subtask.gate === undefined ? null : subtask.gate.accepted ? "accepted" : "rejected",
  };
}

function allPassed(records: readonly { passed: boolean }[]): boolean {
  return records.every((record) => record.passed);
}

function verificationStep(log: RunLog, active: boolean): RunStep {
  const anchor = "verification";
  const { verification, verificationProgress } = log;
  if (verification !== undefined) {
    const passed = verification.environment === undefined && allPassed(verification.checks) && allPassed(verification.criteria);
    return { kind: "integrated-verification", state: passed ? "passed" : "failed", anchor, checks: tally(verification.checks), criteria: tally(verification.criteria) };
  }
  const checks: CheckRecord[] = verificationProgress?.checks ?? [];
  const criteria: CriterionRecord[] = verificationProgress?.criteria ?? [];
  const state = verificationProgress !== undefined && active ? "running" : waiting(active);
  return { kind: "integrated-verification", state, anchor, checks: tally(checks), criteria: tally(criteria) };
}

function testerStep(log: RunLog, verificationPassed: boolean, active: boolean): RunStep | null {
  const anchor = "tester";
  const verification = log.verification;
  const tester = verification?.tester;
  if (tester !== undefined) {
    const passed = tester.error === undefined && allPassed(tester.verdicts);
    return { kind: "acceptance-tester", state: passed ? "passed" : "failed", anchor, phase: null, verdicts: tally(tester.verdicts), error: tester.error ?? null };
  }
  if (log.agents.tester === undefined) return null;
  const phase = active ? (verification?.testerPhase ?? null) : null;
  const state = phase !== null ? "running" : verification !== undefined && !verificationPassed ? "not-run" : waiting(active);
  return { kind: "acceptance-tester", state, anchor, phase, verdicts: tally([]), error: null };
}

function publicationStep(log: RunLog, active: boolean): RunStep {
  const anchor = "step-publication";
  const pullRequest = log.pullRequest === undefined ? null : { number: log.pullRequest.number, url: safeLink(log.pullRequest.url), draft: log.pullRequest.draft };
  const failure = log.publicationFailure?.message ?? null;
  const state = pullRequest !== null ? "passed" : failure !== null ? "failed" : waiting(active);
  return { kind: "publication", state, anchor, pullRequest, failure };
}

export function runSteps(entry: RunEntry, now: Date): RunStep[] {
  const { log } = entry;
  const active = runStatus(entry, now) === "running";
  const verification = verificationStep(log, active);
  const tester = testerStep(log, verification.state === "passed", active);
  return [...log.subtasks.map((subtask) => subtaskStep(subtask, active)), verification, ...(tester === null ? [] : [tester]), publicationStep(log, active)];
}
