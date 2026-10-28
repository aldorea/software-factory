import type { RunEntry } from "../coordinator/run-history.ts";
import type { AgentChangeRecord, EvidenceBranchRecord, RunBlockRecord, RunLog } from "../coordinator/run-log.ts";
import type { RoleChoice } from "../config/config.ts";
import { checkItem } from "./evidence-view.ts";
import { anchor, badge, bullets, escapeHtml, page, titledList } from "./html.ts";
import type { LogUrl } from "./log-path.ts";
import { shouldReload } from "./reload.ts";
import { relativeTime } from "./relative-time.ts";
import { subtasksSection } from "./subtasks-view.ts";
import { verificationSection } from "./verification-view.ts";

export interface RunData {
  entry: RunEntry;
  now: Date;
  logUrl: LogUrl;
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
  const lines = [titledList("h2", "Agentes", items)];
  if (changes.length > 0) lines.push(titledList("h3", "Cambios de agente", changes.map(agentChange)));
  return lines.join("\n");
}

function criteriaOfState(heading: string, ids: string[]): string {
  const items = ids.length === 0 ? ["<li>Ninguno</li>"] : ids.map((id) => `<li>${escapeHtml(id)}</li>`);
  return titledList("h3", heading, items);
}

function criteriaSection({ criteria }: RunLog): string {
  return [
    "<h2>Criterios</h2>",
    criteriaOfState("Pasan", criteria.passing),
    criteriaOfState("Bloqueados", criteria.blocked),
    criteriaOfState("Human", criteria.human),
    criteriaOfState("Pendientes", criteria.pending),
  ].join("\n");
}

function pauseSection(log: RunLog): string {
  if (log.result !== "paused") return "";
  return [
    "<h2>Pausado</h2>",
    `<p>Motivo: ${escapeHtml(log.pauseReason ?? "desconocido")}</p>`,
    `<p>Reset del plan limit: ${escapeHtml(log.resetsAt ?? "desconocido")}</p>`,
  ].join("\n");
}

function blockDetails(block: RunBlockRecord, logUrl: LogUrl): string[] {
  if (block.type === "default-branch-conflict") return block.files.map((file) => `<li>${escapeHtml(file)}</li>`);
  return block.checks.map((check) => checkItem(check, logUrl));
}

function blockSection({ block }: RunLog, logUrl: LogUrl): string {
  if (block === undefined) return "";
  return [
    "<h2>Bloqueo del run</h2>",
    `<p>Tipo: ${escapeHtml(block.type)}</p>`,
    `<p>Motivo: ${escapeHtml(block.reason)}</p>`,
    `<p>Commit: ${escapeHtml(block.sha)}</p>`,
    bullets(blockDetails(block, logUrl)),
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

export function runView({ entry, now, logUrl }: RunData): string {
  const { log } = entry;
  const body = [
    `<p><a href="/">Runs</a></p>`,
    `<h1>#${escapeHtml(String(log.issue))} ${escapeHtml(log.runId)}</h1>`,
    `<p>Resultado: ${badge(log.result)}</p>`,
    `<p>Último cambio: ${escapeHtml(relativeTime(entry.modifiedAt, now))}</p>`,
    linksSection(log),
    pauseSection(log),
    blockSection(log, logUrl),
    agentsSection(log),
    criteriaSection(log),
    subtasksSection(log.subtasks, logUrl),
    verificationSection(log.verification, logUrl),
  ].filter(Boolean);
  return page(`run ${log.runId}`, body.join("\n"), { reload: shouldReload([log]) });
}
