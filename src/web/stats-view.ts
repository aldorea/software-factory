import type { AgentStats, RunStats } from "../coordinator/stats.ts";
import { WORKER_LAYER_FAILURE_KINDS } from "../workers/failures.ts";
import type { AgentKind } from "../workers/types.ts";
import { BLOCK_TYPES } from "../coordinator/run-log.ts";
import { formatDuration } from "../coordinator/stop-rules.ts";
import { escapeHtml } from "./html.ts";

function definitions(rows: Array<[string, string | number]>): string {
  return [
    "<dl>",
    ...rows.map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(String(value))}</dd>`),
    "</dl>",
  ].join("\n");
}

function resultsSection(stats: RunStats): string {
  const { results } = stats;
  return [
    "<h2>Resultados</h2>",
    definitions([
      ["Runs", stats.runs],
      ["Ready", results.ready],
      ["Draft", results.draft],
      ["Paused", results.paused],
      ["Running", results.running],
    ]),
  ].join("\n");
}

function criteriaSection({ criteria }: RunStats): string {
  return [
    "<h2>Criterios</h2>",
    definitions([
      ["Pasan", criteria.passing],
      ["Bloqueados", criteria.blocked],
      ["Human", criteria.human],
      ["Pendientes", criteria.pending],
    ]),
  ].join("\n");
}

function costSection({ cost }: RunStats): string {
  const { perRun, perSubtask } = cost;
  return [
    "<h2>Coste</h2>",
    definitions([
      [
        "Tokens",
        `${cost.countedTokens} (${Math.round(perRun.countedTokens)} por run, ${Math.round(perSubtask.countedTokens)} por subtask, como máximo ${perSubtask.maxCountedTokens} en un subtask)`,
      ],
      ["Attempts", `${cost.attempts} (${perRun.attempts.toFixed(1)} por run, ${perSubtask.attempts.toFixed(1)} por subtask)`],
      ["Wall clock sin pausas", `${formatDuration(cost.wallClockMs)} (${formatDuration(perRun.wallClockMs)} por run)`],
      ["Pausa", formatDuration(cost.pausedMs)],
    ]),
  ].join("\n");
}

function agentsSection({ perAgent }: RunStats): string {
  const rows = (Object.entries(perAgent) as [AgentKind, AgentStats][]).map(
    ([kind, agent]) =>
      `<tr><td>${escapeHtml(kind)}</td><td>${agent.runs}</td><td>${agent.attempts}</td><td>${agent.countedTokens}</td><td>${agent.pauses}</td></tr>`,
  );
  return [
    "<h2>Por agente</h2>",
    "<table>",
    "<thead><tr><th>Agente</th><th>Runs</th><th>Attempts</th><th>Tokens</th><th>Pausas</th></tr></thead>",
    "<tbody>",
    ...rows,
    "</tbody>",
    "</table>",
  ].join("\n");
}

function counts(entries: string[]): string {
  return entries.length > 0 ? entries.join(", ") : "ninguno";
}

function frictionSection({ friction }: RunStats): string {
  const blocks = BLOCK_TYPES.filter((type) => friction.blocks[type] > 0).map((type) => `${type} ${friction.blocks[type]}`);
  return [
    "<h2>Fricción</h2>",
    definitions([
      ["Bloqueos", counts(blocks)],
      ["Scope extensions", friction.scopeExtensions],
      ["Rechazos del gate", friction.gateRejections],
      ["Rechazos del independent verifier", friction.verifierRejections],
      ["Rechazos del acceptance tester", friction.testerRejections],
      ["Conflictos de integración", friction.integrationConflicts],
    ]),
  ].join("\n");
}

function workerLayerSection({ workerLayerFailures }: RunStats): string {
  const failures = WORKER_LAYER_FAILURE_KINDS.filter((kind) => (workerLayerFailures[kind] ?? 0) > 0).map(
    (kind) => `${kind} ${workerLayerFailures[kind]}`,
  );
  return ["<h2>Worker layer</h2>", definitions([["Fallos de la worker layer", counts(failures)]])].join("\n");
}

export function statsView(stats: RunStats): string {
  return [
    "<section>",
    "<h1>Estadísticas</h1>",
    resultsSection(stats),
    criteriaSection(stats),
    costSection(stats),
    agentsSection(stats),
    frictionSection(stats),
    workerLayerSection(stats),
    "</section>",
  ].join("\n");
}
