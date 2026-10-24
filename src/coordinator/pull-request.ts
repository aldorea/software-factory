import { basename } from "node:path";
import type { Issue } from "../github/github.ts";
import { criteriaText } from "../spec/issue.ts";
import type { RoleChoice } from "../config/config.ts";
import { evidencePath } from "./evidence-branch.ts";
import type { AgentChangeRecord, CheckRecord, CriterionRecord, HumanCriterionRecord, RunLog, SubtaskRecord } from "./run-log.ts";

export interface PullRequestText {
  title: string;
  body: string;
}

export function renderPullRequest(issue: Issue, log: RunLog): PullRequestText {
  const sections = [
    `Implements #${issue.number}: ${issue.title}.\n\nCloses #${issue.number}`,
    `## Result\n\n${resultLine(log)}`,
    `## Subtasks\n\n${log.subtasks.map(subtaskLine).join("\n")}`,
    ...scopeExtensionSections(log),
    verificationSection(log),
    ...criteriaSections(issue, log),
    agentsSection(log),
    `Run \`${log.runId}\`: \`.factory/logs/${log.runId}/run.json\``,
  ];
  return { title: `${issue.title} (#${issue.number})`, body: `${sections.join("\n\n")}\n` };
}

const ROLE_NAMES: Record<AgentChangeRecord["role"], string> = {
  workers: "the workers",
  verifier: "the independent verifier",
};

function agentsSection(log: RunLog): string {
  const { workers, verifier, changes } = log.agents;
  const lines = [
    `- Workers: ${choiceText(workers)}`,
    ...(verifier ? [`- Independent verifier: ${choiceText(verifier)}`] : []),
    ...changes.map(
      (change) => `- On resume at ${change.at}, ${ROLE_NAMES[change.role]} changed from ${choiceText(change.from)} to ${choiceText(change.to)}`,
    ),
  ];
  const shared =
    verifier !== undefined && verifier.agent === workers.agent && verifier.model === workers.model
      ? ["\nThe independent verifier used the same model as the workers: its independence rests on its clean context alone."]
      : [];
  return [`## Agents\n\n${lines.join("\n")}`, ...shared].join("\n");
}

function choiceText(choice: RoleChoice): string {
  return `${choice.agent}, model ${choice.model}`;
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
  if (log.verification?.environment !== undefined) {
    failed.push(`the integrated verification failed: ${log.verification.environment}`);
  } else if (log.verification && !log.verification.passed) {
    const failing = log.verification.criteria.filter((criterion) => !criterion.passed).map((criterion) => criterion.id);
    failed.push(
      `the integrated verification failed${failing.length > 0 ? ` (criteria not passing: ${failing.join(", ")})` : ""}`,
    );
  }
  if (log.evidence?.failure !== undefined) failed.push(`the attachments of the human criteria were not published: ${log.evidence.failure}`);
  const layer = log.workerLayerFailures.length;
  if (layer > 0) failed.push(`${layer} failure${layer === 1 ? "" : "s"} of the worker layer, not of the design`);
  return `Draft: ${failed.join("; ")}.`;
}

function subtaskLine(subtask: SubtaskRecord): string {
  const head = `- **${subtask.id}** (${subtask.criteria.join(", ")}): ${subtask.state}`;
  const reason = subtask.reason ? `${head}. ${subtask.reason}` : head;
  const lastFailure = subtask.block?.lastFailure;
  const lines = [
    reason,
    ...(subtask.followUps ?? []).map(
      (followUp) => `  Follow-up ${followUp.round} (${followUp.criteria.join(", ")}): ${followUp.outcome}`,
    ),
    ...(lastFailure ? [`  Last failure: ${lastFailure}`] : []),
  ];
  return lines.join("\n");
}

function scopeExtensionSections(log: RunLog): string[] {
  const lines = log.subtasks
    .filter((subtask) => subtask.scopeExtensions.length > 0)
    .map((subtask) => `- **${subtask.id}**: ${subtask.scopeExtensions.map((path) => `\`${path}\``).join(", ")}`);
  if (lines.length === 0) return [];
  return [`## Scope extensions\n\nThe coordinator added these paths to the scope of a subtask during the run. \`specs/${log.issue}.md\` is unchanged.\n\n${lines.join("\n")}`];
}

function verificationSection(log: RunLog): string {
  if (!log.verification) return "## Integrated verification\n\nNot run.";
  const lines = [
    ...log.verification.checks.map(checkLine),
    ...(log.verification.environment !== undefined ? [`- [ ] The app: ${log.verification.environment}`] : []),
  ];
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
    const lines = log.verification.humanCriteria.map((criterion) => humanLine(criterion, label, log));
    sections.push(`## Human criteria for your review\n\n${[...evidenceNotes(log), ...lines].join("\n")}`);
  }
  return sections;
}

function criterionLine(criterion: CriterionRecord, label: (id: string) => string): string {
  const evidence = `${label(criterion.id)}. Evidence: ${criterion.evidence} \`${criterion.command}\``;
  return criterion.passed ? `- [x] ${evidence}` : `- [ ] ${evidence} failed with exit code ${criterion.exitCode}`;
}

function humanLine(criterion: HumanCriterionRecord, label: (id: string) => string, log: RunLog): string {
  const head = `- [ ] ${label(criterion.id)}. Reason: ${criterion.reason.replace(/[.\s]*$/, "")}. Attachments:`;
  if (criterion.attachments.length === 0) return `${head} none`;
  const evidence = log.evidence;
  if (evidence?.failure === undefined && evidence?.commit !== undefined && evidence.repositoryUrl !== undefined) {
    const links = criterion.attachments.map((attachment) => {
      const name = basename(attachment);
      const url = evidenceUrl(evidence.repositoryUrl ?? "", evidence.commit ?? "", evidencePath(log.runId, criterion.id, attachment));
      return { name, url, image: IMAGE_EXTENSIONS.test(name) };
    });
    const images = links.filter((link) => link.image).map((link) => `\n  ![${link.name}](${link.url}?raw=true)`);
    return `${head} ${links.map((link) => `[${link.name}](${link.url})`).join(", ")}${images.join("")}`;
  }
  return `${head} ${criterion.attachments.map((path) => `\`.factory/logs/${log.runId}/${path}\``).join(", ")}`;
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg)$/i;

function evidenceUrl(repositoryUrl: string, commit: string, path: string): string {
  return `${repositoryUrl}/blob/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function evidenceNotes(log: RunLog): string[] {
  const evidence = log.evidence;
  if (evidence === undefined) return [];
  if (evidence.failure !== undefined) {
    return [
      `The attachments could not be published to \`${evidence.branch}\`: ${evidence.failure}. They stay on the host under \`.factory/logs/${log.runId}/attachments/\`.\n`,
    ];
  }
  return [`The attachments are on branch \`${evidence.branch}\` at \`${(evidence.commit ?? "").slice(0, 12)}\`. That branch is never merged.\n`];
}
