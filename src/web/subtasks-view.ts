import type { AttemptRecord, FollowUpRecord, GateRecord, SubtaskRecord, VerifierRecord } from "../coordinator/run-log.ts";
import { countedTokens } from "../coordinator/stop-rules.ts";
import { checksGroup, criteriaGroup } from "./evidence-view.ts";
import { badge, bullets, escapeHtml, logAnchors, RAW_LOG, titledList } from "./html.ts";
import type { LogUrl } from "./log-path.ts";

function list(values: readonly string[]): string {
  return values.length === 0 ? "ninguno" : values.map(escapeHtml).join(", ");
}

function attemptItem(attempt: AttemptRecord, logUrl: LogUrl): string {
  const lines = [
    `Intento ${attempt.number}: ${attempt.agent.agent} / ${attempt.agent.model}`,
    `Resultado: ${attempt.outcome}`,
  ];
  if (attempt.detail !== undefined) lines.push(`Detalle: ${attempt.detail}`);
  if (attempt.failure !== undefined) lines.push(`Fallo: ${attempt.failure.description}`);
  lines.push(`Tokens: ${countedTokens(attempt.usage)}`, `Inicio: ${attempt.startedAt}`, `Fin: ${attempt.endedAt}`);
  return `<li class="attempt">${[...lines.map(escapeHtml), ...logAnchors(logUrl(attempt.logPath), RAW_LOG)].join("<br>\n")}</li>`;
}

function attemptsList(attempts: readonly AttemptRecord[], logUrl: LogUrl): string {
  if (attempts.length === 0) return "";
  return titledList("h4", "Intentos", attempts.map((attempt) => attemptItem(attempt, logUrl)));
}

function verifierItem(record: VerifierRecord, logUrl: LogUrl): string {
  const reason = record.reason === undefined ? "" : ` (${record.reason})`;
  const text = `${escapeHtml(record.id)}: ${badge(record.verdict)}${escapeHtml(reason)}`;
  return `<li class="verifier">${[text, ...logAnchors(logUrl(record.logPath), RAW_LOG)].join(" ")}</li>`;
}

function verifierGroup(records: readonly VerifierRecord[], logUrl: LogUrl): string {
  if (records.length === 0) return "";
  return titledList("h4", "Independent verifier", records.map((record) => verifierItem(record, logUrl)));
}

function reasonsList(reasons: readonly string[]): string {
  if (reasons.length === 0) return "";
  return bullets(reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`));
}

function gateBlock(gate: GateRecord | undefined, logUrl: LogUrl): string {
  if (gate === undefined) return "";
  return [
    `<h4>Gate ${escapeHtml(gate.sha)}: ${badge(gate.accepted ? "aceptado" : "rechazado")}</h4>`,
    reasonsList(gate.reasons),
    checksGroup(gate.checks, logUrl),
    criteriaGroup(gate.criteria, logUrl),
    verifierGroup(gate.verifier, logUrl),
  ]
    .filter(Boolean)
    .join("\n");
}

function blockedBlock(subtask: SubtaskRecord): string {
  if (subtask.state !== "blocked") return "";
  const type = subtask.blockType ?? subtask.block?.type;
  const reason = subtask.reason ?? subtask.block?.reason;
  const lines = [];
  if (type !== undefined) lines.push(`<p>Bloqueo: ${escapeHtml(type)}</p>`);
  if (reason !== undefined) lines.push(`<p>Motivo: ${escapeHtml(reason)}</p>`);
  if (subtask.block?.lastFailure !== undefined) lines.push(`<p>Último fallo: ${escapeHtml(subtask.block.lastFailure)}</p>`);
  return lines.join("\n");
}

function followUpItem(followUp: FollowUpRecord): string {
  const lines = [
    `Follow-up ronda ${followUp.round}`,
    `Criterios: ${list(followUp.criteria)}`,
    `Fallo: ${followUp.failure}`,
    `Resultado: ${followUp.outcome}`,
  ];
  return `<li class="follow-up">${lines.map(escapeHtml).join("<br>\n")}</li>`;
}

function followUpsList(followUps: readonly FollowUpRecord[] | undefined): string {
  if (followUps === undefined || followUps.length === 0) return "";
  return titledList("h4", "Follow-up tasks", followUps.map(followUpItem));
}

function subtaskBlock(subtask: SubtaskRecord, logUrl: LogUrl): string {
  return [
    `<section class="subtask">`,
    `<h3>${escapeHtml(subtask.id)}</h3>`,
    `<p>Estado: ${badge(subtask.state)}</p>`,
    `<p>Criterios: ${list(subtask.criteria)}</p>`,
    `<p>Branch: ${escapeHtml(subtask.branch)}</p>`,
    `<p>Scope extensions: ${list(subtask.scopeExtensions)}</p>`,
    blockedBlock(subtask),
    attemptsList(subtask.attempts, logUrl),
    `<p>${subtask.gateRejections} rechazos del gate</p>`,
    `<p>${subtask.verifierRejections} rechazos del independent verifier</p>`,
    gateBlock(subtask.gate, logUrl),
    followUpsList(subtask.followUps),
    "</section>",
  ].filter(Boolean).join("\n");
}

export function subtasksSection(subtasks: readonly SubtaskRecord[], logUrl: LogUrl): string {
  const body = subtasks.length === 0 ? ["<p>Sin subtareas</p>"] : subtasks.map((subtask) => subtaskBlock(subtask, logUrl));
  return ["<h2>Subtareas</h2>", ...body].join("\n");
}
