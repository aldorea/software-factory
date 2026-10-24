import type { AgentKind, TokenUsage } from "../workers/types.ts";

export type StopType = "patience" | "subtask-wall-clock" | "subtask-tokens" | "run-wall-clock" | "run-tokens";

export interface StopReason {
  type: StopType;
  reason: string;
}

export interface StopLimits {
  patience: number;
  subtaskWallClockMs: number;
  subtaskTokens: number;
  runWallClockMs: number;
  runTokens: number;
}

export interface StopInput {
  signatures: string[];
  subtaskElapsedMs: number;
  subtaskTokens: number;
  runElapsedMs: number;
  runTokens: number;
}

export function countedTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.cacheCreationInputTokens + usage.outputTokens;
}

export function agentTokens(attempts: { agent: { agent: AgentKind }; usage: TokenUsage }[], agent: AgentKind): number {
  return attempts.filter((attempt) => attempt.agent.agent === agent).reduce((total, attempt) => total + countedTokens(attempt.usage), 0);
}

export function stopReason(input: StopInput, limits: StopLimits): StopReason | null {
  if (input.runElapsedMs >= limits.runWallClockMs) {
    return {
      type: "run-wall-clock",
      reason: `The run reached its wall clock limit of ${formatDuration(limits.runWallClockMs)}.`,
    };
  }
  if (input.runTokens >= limits.runTokens) {
    return { type: "run-tokens", reason: `The run reached its limit of ${formatCount(limits.runTokens)} tokens.` };
  }
  if (input.subtaskElapsedMs >= limits.subtaskWallClockMs) {
    return {
      type: "subtask-wall-clock",
      reason: `The subtask reached its wall clock limit of ${formatDuration(limits.subtaskWallClockMs)}.`,
    };
  }
  if (input.subtaskTokens >= limits.subtaskTokens) {
    return {
      type: "subtask-tokens",
      reason: `The subtask reached its limit of ${formatCount(limits.subtaskTokens)} tokens.`,
    };
  }
  const last = input.signatures.at(-1);
  if (last !== undefined && trailingRun(input.signatures) >= limits.patience) {
    return {
      type: "patience",
      reason: `${limits.patience} attempts in a row failed with the same error signature: ${last}.`,
    };
  }
  return null;
}

function trailingRun(signatures: string[]): number {
  const last = signatures.at(-1);
  let count = 0;
  for (let index = signatures.length - 1; index >= 0 && signatures[index] === last; index -= 1) count += 1;
  return count;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.round(ms / 1000)} s`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
