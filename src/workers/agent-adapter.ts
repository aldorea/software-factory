import type { SupervisedProcess } from "./supervise.ts";
import type { ActivityEvent, AgentKind, AttemptOutcome, PlanStatus, TokenUsage } from "./types.ts";

export interface AgentCapabilities {
  readsTokenUsage: boolean;
  detectsPlanLimit: boolean;
  deniesEveryTool: boolean;
  startsInteractiveSession: boolean;
}

export type RunRole = "workers" | "verifier" | "tester";

export type Role = RunRole | "refinement";

export type UsageReading = { ok: true; usage: TokenUsage } | { ok: false; problem: string };

export interface UsageProbe {
  command(): string[] | undefined;
  parse(output: string): UsageReading;
}

export interface AgentStream {
  onLine(line: string): void;
  activity?(line: string): ActivityEvent[];
  finish?(outcome: AttemptOutcome): ActivityEvent[];
  usage(): TokenUsage;
  usageProbe?: UsageProbe;
  plan(): PlanStatus | undefined;
  outcome(supervised: SupervisedProcess): AttemptOutcome;
}

export interface AgentAdapter {
  kind: AgentKind;
  processName: string;
  capabilities: AgentCapabilities;
  command(model: string): string[];
  isFinalLine?(line: string): boolean;
  createStream(): AgentStream;
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 };
}
