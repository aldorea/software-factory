import type { Issue } from "../github/github.ts";
import type { CheckRecord, RunLog, SubtaskRecord } from "./run-log.ts";

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
    `## Agents\n\n- Workers: ${log.agents.workers.agent}, model ${log.agents.workers.model}`,
    `Run \`${log.runId}\`: \`.factory/logs/${log.runId}/run.json\``,
  ];
  return { title: `${issue.title} (#${issue.number})`, body: `${sections.join("\n\n")}\n` };
}

function resultLine(log: RunLog): string {
  if (log.result === "ready") return "Ready for review: every subtask merged and the integrated verification passed.";
  if (log.result === "paused") return `Paused: ${log.pauseReason ?? "unknown reason"}. Run factory run ${log.issue} again to resume.`;
  const failed: string[] = [];
  const blocked = log.subtasks.filter((subtask) => subtask.state !== "merged").map((subtask) => subtask.id);
  if (blocked.length > 0) failed.push(`subtasks not merged: ${blocked.join(", ")}`);
  if (log.verification && !log.verification.passed) failed.push("the integrated verification failed");
  return `Draft: ${failed.join("; ")}.`;
}

function subtaskLine(subtask: SubtaskRecord): string {
  const head = `- **${subtask.id}** (${subtask.criteria.join(", ")}): ${subtask.state}`;
  return subtask.reason ? `${head}. ${subtask.reason}` : head;
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
