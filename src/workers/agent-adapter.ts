import type { SupervisedProcess } from "./supervise.ts";
import type { AgentKind, AttemptOutcome, PlanStatus, TokenUsage } from "./types.ts";

export interface AgentCapabilities {
  readsTokenUsage: boolean;
  detectsPlanLimit: boolean;
  deniesEveryTool: boolean;
}

export type Role = "workers" | "verifier";

export interface AgentStream {
  onLine(line: string): void;
  usage(): TokenUsage;
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
