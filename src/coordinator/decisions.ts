import { criteriaHash, readApproval, technicalHash } from "../spec/approval.ts";
import type { CheckRecord, CriterionRecord, RunLog, RunResult } from "./run-log.ts";

export function approvalProblem(issue: number, specText: string, issueBody: string): string | null {
  const state = readApproval(specText);
  if (state.kind === "not-approved") return `specs/${issue}.md is not approved; run factory approve ${issue} first`;
  if (state.kind === "malformed") return `specs/${issue}.md has a malformed approval: ${state.reason}`;
  const changed: string[] = [];
  if (criteriaHash(issueBody) !== state.approval.criteriaHash) {
    changed.push(`the acceptance criteria of issue #${issue} changed`);
  }
  if (technicalHash(specText) !== state.approval.technicalHash) changed.push(`specs/${issue}.md changed`);
  if (changed.length === 0) return null;
  return `${changed.join(" and ")} since the approval; review the spec and run factory approve ${issue} again`;
}

export interface GateDecision {
  accepted: boolean;
  reasons: string[];
}

export function gateDecision(checks: CheckRecord[], criteria: CriterionRecord[] = []): GateDecision {
  const reasons = [
    ...checks.filter((check) => !check.passed).map((check) => `check ${check.name} failed with exit code ${check.exitCode}`),
    ...criteria
      .filter((criterion) => !criterion.passed)
      .map((criterion) => `criterion ${criterion.id} (${criterion.evidence}) failed with exit code ${criterion.exitCode}`),
  ];
  return { accepted: reasons.length === 0, reasons };
}

export function verificationPassed(checks: CheckRecord[], criteria: CriterionRecord[]): boolean {
  return checks.every((check) => check.passed) && criteria.every((criterion) => criterion.passed);
}

export function runResult(log: Pick<RunLog, "subtasks" | "verification" | "pauseReason">): Exclude<RunResult, "running"> {
  if (log.pauseReason !== undefined) return "paused";
  const merged = log.subtasks.every((subtask) => subtask.state === "merged");
  return merged && log.verification?.passed === true ? "ready" : "draft";
}

export function runId(issue: number, now: Date): string {
  return `${issue}-${now.toISOString().replace(/[:.]/g, "-")}`;
}
