import { WORKER_LAYER_FAILURE_KINDS, type WorkerLayerFailureKind } from "../workers/failures.ts";
import type { AgentKind, TokenUsage } from "../workers/types.ts";
import { BLOCK_TYPES, type CriteriaRecord, type FrictionRecord, type RunLog, type RunResult } from "./run-log.ts";
import { emptyFriction } from "./run-totals.ts";
import { countedTokens, formatDuration } from "./stop-rules.ts";

export interface AgentStats {
  runs: number;
  attempts: number;
  countedTokens: number;
  pauses: number;
}

export interface RunStats {
  runs: number;
  results: Record<RunResult, number>;
  criteria: Record<keyof CriteriaRecord, number>;
  cost: {
    attempts: number;
    countedTokens: number;
    wallClockMs: number;
    pausedMs: number;
    perRun: { attempts: number; countedTokens: number; wallClockMs: number };
    perSubtask: { count: number; attempts: number; countedTokens: number; maxCountedTokens: number };
  };
  perAgent: Partial<Record<AgentKind, AgentStats>>;
  friction: FrictionRecord;
  workerLayerFailures: Partial<Record<WorkerLayerFailureKind, number>>;
}

function average(total: number, count: number): number {
  return count === 0 ? 0 : total / count;
}

export function summarizeRuns(logs: readonly RunLog[]): RunStats {
  const stats: RunStats = {
    runs: logs.length,
    results: { ready: 0, draft: 0, paused: 0, running: 0 },
    criteria: { passing: 0, blocked: 0, human: 0, pending: 0 },
    cost: {
      attempts: 0,
      countedTokens: 0,
      wallClockMs: 0,
      pausedMs: 0,
      perRun: { attempts: 0, countedTokens: 0, wallClockMs: 0 },
      perSubtask: { count: 0, attempts: 0, countedTokens: 0, maxCountedTokens: 0 },
    },
    perAgent: {},
    friction: emptyFriction(),
    workerLayerFailures: {},
  };
  const agent = (kind: AgentKind): AgentStats =>
    (stats.perAgent[kind] ??= { runs: 0, attempts: 0, countedTokens: 0, pauses: 0 });
  let subtaskTokens = 0;
  let subtaskAttempts = 0;
  for (const log of logs) {
    stats.results[log.result] += 1;
    for (const key of Object.keys(stats.criteria) as (keyof CriteriaRecord)[]) stats.criteria[key] += log.criteria[key].length;
    stats.cost.attempts += log.cost.attempts;
    stats.cost.countedTokens += countedTokens(log.cost.usage);
    stats.cost.wallClockMs += log.cost.wallClockMs;
    stats.cost.pausedMs += log.cost.pausedMs;
    agent(log.agents.workers.agent).runs += 1;
    for (const pause of log.pauses ?? []) agent(pause.agent).pauses += 1;
    for (const subtask of log.subtasks) {
      const tokens = countedTokens(subtask.usage);
      stats.cost.perSubtask.count += 1;
      subtaskTokens += tokens;
      subtaskAttempts += subtask.attempts.length;
      stats.cost.perSubtask.maxCountedTokens = Math.max(stats.cost.perSubtask.maxCountedTokens, tokens);
      for (const attempt of subtask.attempts) {
        agent(attempt.agent.agent).attempts += 1;
        agent(attempt.agent.agent).countedTokens += countedTokens(attempt.usage);
      }
      for (const [kind, usage] of Object.entries(subtask.verifierUsage ?? {}) as [AgentKind, TokenUsage][]) {
        agent(kind).countedTokens += countedTokens(usage);
      }
    }
    for (const type of BLOCK_TYPES) stats.friction.blocks[type] += log.friction.blocks[type] ?? 0;
    stats.friction.scopeExtensions += log.friction.scopeExtensions;
    stats.friction.gateRejections += log.friction.gateRejections;
    stats.friction.verifierRejections += log.friction.verifierRejections;
    stats.friction.integrationConflicts += log.friction.integrationConflicts;
    for (const failure of log.workerLayerFailures) {
      stats.workerLayerFailures[failure.kind] = (stats.workerLayerFailures[failure.kind] ?? 0) + 1;
    }
  }
  stats.cost.perRun = {
    attempts: average(stats.cost.attempts, logs.length),
    countedTokens: average(stats.cost.countedTokens, logs.length),
    wallClockMs: average(stats.cost.wallClockMs, logs.length),
  };
  stats.cost.perSubtask.attempts = average(subtaskAttempts, stats.cost.perSubtask.count);
  stats.cost.perSubtask.countedTokens = average(subtaskTokens, stats.cost.perSubtask.count);
  return stats;
}

export function formatStats(stats: RunStats, unreadable: readonly string[] = []): string {
  const unreadableLine = unreadable.length > 0 ? [`Unreadable run.json files: ${unreadable.join(", ")}`] : [];
  if (stats.runs === 0) return ["No runs yet: .factory/logs has no run.json files.", ...unreadableLine].join("\n");
  const { results, criteria, cost, friction } = stats;
  const blocks = BLOCK_TYPES.filter((type) => friction.blocks[type] > 0).map((type) => `${type} ${friction.blocks[type]}`);
  const failures = WORKER_LAYER_FAILURE_KINDS.filter((kind) => (stats.workerLayerFailures[kind] ?? 0) > 0).map(
    (kind) => `${kind} ${stats.workerLayerFailures[kind]}`,
  );
  const agents = (Object.entries(stats.perAgent) as [AgentKind, AgentStats][]).map(
    ([kind, agent]) =>
      `  ${kind}: ${plural(agent.runs, "run")}, ${plural(agent.attempts, "attempt")}, ${agent.countedTokens} tokens, ${plural(agent.pauses, "pause")}`,
  );
  const running = results.running > 0 ? `, running ${results.running}` : "";
  return [
    `Runs: ${stats.runs} (ready ${results.ready}, draft ${results.draft}, paused ${results.paused}${running})`,
    `Criteria: passing ${criteria.passing}, blocked ${criteria.blocked}, human ${criteria.human}, pending ${criteria.pending}`,
    "",
    "Cost",
    `  Tokens: ${cost.countedTokens} (${Math.round(cost.perRun.countedTokens)} per run, ${Math.round(cost.perSubtask.countedTokens)} per subtask, at most ${cost.perSubtask.maxCountedTokens} in one subtask)`,
    `  Attempts: ${cost.attempts} (${cost.perRun.attempts.toFixed(1)} per run, ${cost.perSubtask.attempts.toFixed(1)} per subtask)`,
    `  Wall clock without pauses: ${formatDuration(cost.wallClockMs)} (${formatDuration(cost.perRun.wallClockMs)} per run)`,
    "",
    "Per agent",
    ...agents,
    "",
    "Friction",
    `  Blocks: ${blocks.length > 0 ? blocks.join(", ") : "none"}`,
    `  Scope extensions: ${friction.scopeExtensions}`,
    `  Gate rejections: ${friction.gateRejections}`,
    `  Verifier rejections: ${friction.verifierRejections}`,
    `  Integration conflicts: ${friction.integrationConflicts}`,
    "",
    `Worker-layer failures: ${failures.length > 0 ? failures.join(", ") : "none"}`,
    ...unreadableLine,
  ].join("\n");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
