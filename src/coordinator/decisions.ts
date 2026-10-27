import { criteriaHash, readApproval, technicalHash } from "../spec/approval.ts";
import type { CheckRecord, CriterionRecord, RunLog, RunResult } from "./run-log.ts";
import type { GateDecision, GateRejection } from "./gate.ts";
import type { TestJudgment } from "./test-judgment.ts";

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

export function verifiedDecision(decision: GateDecision, judgment: TestJudgment): GateDecision {
  const rejections: GateRejection[] = [
    ...decision.rejections,
    ...judgment.missingTests.map((id) => ({
      kind: "criterion" as const,
      message: `criterion ${id} (playwright) has no test that carries its ID in the changes of the subtask`,
      signature: `no-test:${id}`,
    })),
    ...judgment.records.flatMap((record): GateRejection[] => {
      if (record.verdict === "refute") {
        return [
          {
            kind: "verifier",
            message: `the verifier refuted the test of ${record.id}: ${record.reason ?? ""}`,
            signature: `verifier:${record.id}:refute`,
          },
        ];
      }
      if (record.verdict === "error") {
        return [
          {
            kind: "verifier",
            message: `the verifier gave no usable answer for ${record.id}: ${record.reason ?? ""}`,
            signature: `verifier:${record.id}:error`,
          },
        ];
      }
      return [];
    }),
  ];
  return {
    accepted: rejections.length === 0,
    reasons: rejections.map((rejection) => rejection.message),
    rejections,
    signature: rejections.map((rejection) => rejection.signature).join(" | "),
  };
}

export function verificationPassed(checks: CheckRecord[], criteria: CriterionRecord[]): boolean {
  return checks.every((check) => check.passed) && criteria.every((criterion) => criterion.passed);
}

export function runResult(
  log: Pick<RunLog, "subtasks" | "verification" | "pauseReason" | "evidence" | "block">,
): Exclude<RunResult, "running"> {
  if (log.pauseReason !== undefined) return "paused";
  const merged = log.subtasks.every((subtask) => subtask.state === "merged");
  return merged && log.verification?.passed === true && log.evidence?.failure === undefined && log.block === undefined ? "ready" : "draft";
}

export function runId(issue: number, now: Date): string {
  return `${issue}-${now.toISOString().replace(/[:.]/g, "-")}`;
}
