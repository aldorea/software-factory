import type { RunEntry } from "../coordinator/run-history.ts";
import type { AgentChangeRecord, EvidenceBranchRecord, RunBlockRecord, RunLog } from "../coordinator/run-log.ts";
import type { RoleChoice } from "../config/config.ts";
import { anchor, escapeHtml, page } from "./html.ts";
import { shouldReload } from "./reload.ts";
import { relativeTime } from "./relative-time.ts";

export interface RunData {
  entry: RunEntry;
  now: Date;
}

function choiceText(choice: RoleChoice): string {
  return `${choice.agent} / ${choice.model}`;
}

function agentChange(change: AgentChangeRecord): string {
  const text = `${change.role}: ${choiceText(change.from)} → ${choiceText(change.to)} (${change.at})`;
  return `<li>${escapeHtml(text)}</li>`;
}

function agentsSection({ agents }: RunLog): string {
  const { changes, ...roles } = agents;
  const items = Object.entries(roles).map(
    ([role, choice]) => `<li>${escapeHtml(role)}: ${escapeHtml(choiceText(choice as RoleChoice))}</li>`,
  );
  const lines = ["<h2>Agentes</h2>", "<ul>", ...items, "</ul>"];
  if (changes.length > 0) lines.push("<h3>Cambios de agente</h3>", "<ul>", ...changes.map(agentChange), "</ul>");
  return lines.join("\n");
}

function criteriaGroup(heading: string, ids: string[]): string {
  const items = ids.length === 0 ? ["<li>Ninguno</li>"] : ids.map((id) => `<li>${escapeHtml(id)}</li>`);
  return [`<h3>${heading}</h3>`, "<ul>", ...items, "</ul>"].join("\n");
}

function criteriaSection({ criteria }: RunLog): string {
  return [
    "<h2>Criterios</h2>",
    criteriaGroup("Pasan", criteria.passing),
    criteriaGroup("Bloqueados", criteria.blocked),
    criteriaGroup("Human", criteria.human),
    criteriaGroup("Pendientes", criteria.pending),
  ].join("\n");
}

function pauseSection(log: RunLog): string {
  if (log.result !== "paused") return "";
  const resets = log.resetsAt === undefined ? "desconocido" : log.resetsAt;
  return [
    "<h2>Pausado</h2>",
    `<p>Motivo: ${escapeHtml(log.pauseReason ?? "desconocido")}</p>`,
    `<p>Reset del plan limit: ${escapeHtml(resets)}</p>`,
  ].join("\n");
}

function blockDetails(block: RunBlockRecord): string[] {
  if (block.type === "default-branch-conflict") return block.files.map((file) => `<li>${escapeHtml(file)}</li>`);
  return block.checks.map((check) => `<li>${escapeHtml(check.name)}: ${check.passed ? "pasa" : "falla"}</li>`);
}

function blockSection({ block }: RunLog): string {
  if (block === undefined) return "";
  return [
    "<h2>Bloqueo del run</h2>",
    `<p>Tipo: ${escapeHtml(block.type)}</p>`,
    `<p>Motivo: ${escapeHtml(block.reason)}</p>`,
    `<p>Commit: ${escapeHtml(block.sha)}</p>`,
    "<ul>",
    ...blockDetails(block),
    "</ul>",
  ].join("\n");
}

function evidenceBranchLink(evidence: EvidenceBranchRecord): string {
  if (evidence.repositoryUrl === undefined) return escapeHtml(evidence.branch);
  const path = evidence.branch.split("/").map(encodeURIComponent).join("/");
  return anchor(`${evidence.repositoryUrl}/tree/${path}`, evidence.branch);
}

function linksSection({ pullRequest, evidence }: RunLog): string {
  const lines: string[] = [];
  if (pullRequest !== undefined) {
    const draft = pullRequest.draft ? " (draft)" : "";
    lines.push(`<p>Pull request: ${anchor(pullRequest.url, `#${pullRequest.number}`)}${draft}</p>`);
  }
  if (evidence !== undefined) {
    const failure = evidence.failure === undefined ? "" : ` (fallo: ${escapeHtml(evidence.failure)})`;
    lines.push(`<p>Evidence branch: ${evidenceBranchLink(evidence)}${failure}</p>`);
  }
  return lines.join("\n");
}

export function runView({ entry, now }: RunData): string {
  const { log } = entry;
  const body = [
    `<p><a href="/">Runs</a></p>`,
    `<h1>#${escapeHtml(String(log.issue))} ${escapeHtml(log.runId)}</h1>`,
    `<p>Resultado: ${escapeHtml(log.result)}</p>`,
    `<p>Último cambio: ${escapeHtml(relativeTime(entry.modifiedAt, now))}</p>`,
    linksSection(log),
    pauseSection(log),
    blockSection(log),
    agentsSection(log),
    criteriaSection(log),
  ].filter(Boolean);
  return page(`run ${log.runId}`, body.join("\n"), { reload: shouldReload([log]) });
}
