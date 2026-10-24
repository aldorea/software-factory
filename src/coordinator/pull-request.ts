import type { Issue } from "../github/github.ts";
import { criteriaText } from "../spec/issue.ts";
import type { CheckRecord, CriterionRecord, HumanCriterionRecord, RunLog, SubtaskRecord } from "./run-log.ts";

export interface PullRequestText {
  title: string;
  body: string;
}

export function renderPullRequest(issue: Issue, log: RunLog): PullRequestText {
  const sections = [
    `Implements #${issue.number}: ${issue.title}.\n\nCloses #${issue.number}`,
    `## Result\n\n${resultLine(log)}`,
    `## Subtasks\n\n${log.subtasks.map(subtaskLine).join("\n")}`,
    verificationSection(log),
    ...criteriaSections(issue, log),
    `## Agents\n\n- Workers: ${log.agents.workers.agent}, model ${log.agents.workers.model}`,
    `Run \`${log.runId}\`: \`.factory/logs/${log.runId}/run.json\``,
  ];
  return { title: `${issue.title} (#${issue.number})`, body: `${sections.join("\n\n")}\n` };
}

function resultLine(log: RunLog): string {
  if (log.result === "ready") return "Ready for review: every subtask merged and the integrated verification passed.";
  if (log.result === "paused") {
    const reset = log.resetsAt === undefined ? "The reset time is unknown." : `It resets at ${log.resetsAt}.`;
    return `Paused: ${log.pauseReason ?? "unknown reason"}. ${reset} Run factory run ${log.issue} again to resume.`;
  }
  const failed: string[] = [];
  const blocked = log.subtasks.filter((subtask) => subtask.state !== "merged").map((subtask) => subtask.id);
  if (blocked.length > 0) failed.push(`subtasks not merged: ${blocked.join(", ")}`);
  if (log.verification && !log.verification.passed) {
    const failing = log.verification.criteria.filter((criterion) => !criterion.passed).map((criterion) => criterion.id);
    failed.push(
      `the integrated verification failed${failing.length > 0 ? ` (criteria not passing: ${failing.join(", ")})` : ""}`,
    );
  }
  const layer = log.workerLayerFailures.length;
  if (layer > 0) failed.push(`${layer} failure${layer === 1 ? "" : "s"} of the worker layer, not of the design`);
  return `Draft: ${failed.join("; ")}.`;
}

function subtaskLine(subtask: SubtaskRecord): string {
  const head = `- **${subtask.id}** (${subtask.criteria.join(", ")}): ${subtask.state}`;
  const reason = subtask.reason ? `${head}. ${subtask.reason}` : head;
  const lastFailure = subtask.block?.lastFailure;
  return lastFailure ? `${reason}\n  Last failure: ${lastFailure}` : reason;
}

function verificationSection(log: RunLog): string {
  if (!log.verification) return "## Integrated verification\n\nNot run.";
  const lines = log.verification.checks.map(checkLine);
  return `## Integrated verification on \`${log.verification.sha.slice(0, 12)}\`\n\n${lines.join("\n")}`;
}

function checkLine(check: CheckRecord): string {
  return check.passed
    ? `- [x] ${check.name}: \`${check.command}\``
    : `- [ ] ${check.name}: \`${check.command}\` failed with exit code ${check.exitCode}`;
}

function criteriaSections(issue: Issue, log: RunLog): string[] {
  if (!log.verification) return [];
  const texts = criteriaText(issue.body);
  const label = (id: string) => (texts[id] ?? id).replace(/[.\s]*$/, "");
  const sections = [
    `## Criteria on \`${log.verification.sha.slice(0, 12)}\`\n\n${log.verification.criteria.map((criterion) => criterionLine(criterion, label)).join("\n")}`,
  ];
  if (log.verification.humanCriteria.length > 0) {
    const lines = log.verification.humanCriteria.map((criterion) => humanLine(criterion, label, log.runId));
    sections.push(`## Human criteria for your review\n\n${lines.join("\n")}`);
  }
  return sections;
}

function criterionLine(criterion: CriterionRecord, label: (id: string) => string): string {
  const evidence = `${label(criterion.id)}. Evidence: ${criterion.evidence} \`${criterion.command}\``;
  return criterion.passed ? `- [x] ${evidence}` : `- [ ] ${evidence} failed with exit code ${criterion.exitCode}`;
}

function humanLine(criterion: HumanCriterionRecord, label: (id: string) => string, runId: string): string {
  const attachments =
    criterion.attachments.length > 0
      ? criterion.attachments.map((path) => `\`.factory/logs/${runId}/${path}\``).join(", ")
      : "none";
  return `- [ ] ${label(criterion.id)}. Reason: ${criterion.reason.replace(/[.\s]*$/, "")}. Attachments: ${attachments}`;
}
