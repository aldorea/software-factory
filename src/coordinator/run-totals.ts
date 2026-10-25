import { emptyUsage } from "../workers/agent-adapter.ts";
import type { AgentKind, TokenUsage } from "../workers/types.ts";
import {
  BLOCK_TYPES,
  type BlockType,
  type CostRecord,
  type CriteriaRecord,
  type FrictionRecord,
  type RunLog,
  type SubtaskRecord,
} from "./run-log.ts";
import { countedTokens } from "./stop-rules.ts";

export function emptyCost(): CostRecord {
  return { usage: emptyUsage(), perAgent: {}, attempts: 0, wallClockMs: 0, pausedMs: 0 };
}

export function emptyFriction(): FrictionRecord {
  const blocks = Object.fromEntries(BLOCK_TYPES.map((type) => [type, 0])) as Record<BlockType, number>;
  return { blocks, scopeExtensions: 0, gateRejections: 0, verifierRejections: 0, integrationConflicts: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

export function sumUsage(usages: Iterable<TokenUsage>): TokenUsage {
  let total = emptyUsage();
  for (const usage of usages) total = addUsage(total, usage);
  return total;
}

export function applyTotals(log: RunLog, now: Date): void {
  for (const subtask of log.subtasks) subtask.usage = sumUsage(subtask.attempts.map((attempt) => attempt.usage));
  log.cost = costOf(log, now);
  log.friction = frictionOf(log.subtasks);
  log.criteria = criteriaOf(log);
}

export function agentRunTokens(log: RunLog, agent: AgentKind): number {
  const attempts = log.subtasks.flatMap((subtask) => subtask.attempts).filter((attempt) => attempt.agent.agent === agent);
  const verified = log.subtasks.map((subtask) => subtask.verifierUsage?.[agent] ?? emptyUsage());
  return [...attempts.map((attempt) => attempt.usage), ...verified].reduce((total, usage) => total + countedTokens(usage), 0);
}

function costOf(log: RunLog, now: Date): CostRecord {
  const attempts = log.subtasks.flatMap((subtask) => subtask.attempts);
  const perAgent: CostRecord["perAgent"] = {};
  const charge = (agent: AgentKind, usage: TokenUsage) => {
    perAgent[agent] = addUsage(perAgent[agent] ?? emptyUsage(), usage);
  };
  for (const attempt of attempts) charge(attempt.agent.agent, attempt.usage);
  const verified: TokenUsage[] = [];
  for (const subtask of log.subtasks) {
    for (const [agent, usage] of Object.entries(subtask.verifierUsage ?? {}) as [AgentKind, TokenUsage][]) {
      charge(agent, usage);
      verified.push(usage);
    }
  }
  const end = log.endedAt === undefined ? now.getTime() : Date.parse(log.endedAt);
  return {
    usage: addUsage(sumUsage(log.subtasks.map((subtask) => subtask.usage)), sumUsage(verified)),
    perAgent,
    attempts: attempts.length,
    wallClockMs: Math.max(0, end - Date.parse(log.startedAt) - log.cost.pausedMs),
    pausedMs: log.cost.pausedMs,
  };
}

function frictionOf(subtasks: SubtaskRecord[]): FrictionRecord {
  const friction = emptyFriction();
  for (const subtask of subtasks) {
    if (subtask.state === "blocked" && subtask.blockType !== undefined) friction.blocks[subtask.blockType] += 1;
    friction.scopeExtensions += subtask.scopeExtensions.length;
    friction.gateRejections += subtask.gateRejections;
    friction.verifierRejections += subtask.verifierRejections;
    friction.integrationConflicts += subtask.conflicts;
  }
  return friction;
}

function criteriaOf(log: RunLog): CriteriaRecord {
  const human = new Set(log.criteria.human);
  const ids = [...new Set(log.subtasks.flatMap((subtask) => subtask.criteria))].filter((id) => !human.has(id));
  const verified = log.verification?.passed === true;
  const criteria: CriteriaRecord = { passing: [], blocked: [], human: log.criteria.human, pending: [] };
  for (const id of ids) {
    const holders = log.subtasks.filter((subtask) => subtask.criteria.includes(id));
    if (holders.some((subtask) => subtask.state === "blocked")) criteria.blocked.push(id);
    else if (verified && holders.every((subtask) => subtask.state === "merged")) criteria.passing.push(id);
    else criteria.pending.push(id);
  }
  return criteria;
}
