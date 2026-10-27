import type { ResolvedConfig, Role, RoleChoice, WorkerEnvironmentContext } from "../config/config.ts";
import type { Issue } from "../github/github.ts";
import type { Spec } from "../spec/spec.ts";
import type { AgentKind } from "../workers/types.ts";
import type { ParallelismBounds } from "./parallelism.ts";
import type { RunPorts } from "./ports.ts";
import type { CarriedLoopRecord, RunLog, SubtaskRecord } from "./run-log.ts";
import type { Schedule } from "./schedule.ts";
import type { Lock } from "./slots.ts";
import type { StopLimits } from "./stop-rules.ts";

export interface RunRequest {
  repoDir: string;
  issue: number;
  credentials: Partial<Record<AgentKind, string>>;
  roles?: Partial<Record<Role, RoleChoice>>;
}

export interface Prepared {
  config: ResolvedConfig;
  issue: Issue;
  branch: string;
  defaultBranch: string;
  spec: Spec;
  plan: Schedule;
  parallelism: ParallelismBounds;
  humanCriteria: string[];
  workers: RoleChoice;
  verifier: RoleChoice;
  tester: RoleChoice;
  credential: string;
}

export interface RunContext {
  request: RunRequest;
  ports: RunPorts;
  prepared: Prepared;
  log: RunLog;
  runDir: string;
  startedAt: Date;
  runStartSha: string;
  existingTestPaths: ReadonlySet<string>;
  requestChecks: string[];
  records: ReadonlyMap<string, SubtaskRecord>;
  scopes: ReadonlyMap<string, string[]>;
  budgets: Map<string, CarriedLoopRecord>;
  gitLock: Lock;
  conflicted: boolean;
  verifications: number;
  save(): Promise<void>;
  noteFailure(error: unknown, subtaskId: string | null): Promise<void>;
}

export function paused(context: RunContext): boolean {
  return context.log.pauseReason !== undefined;
}

export function environment(config: ResolvedConfig, context: WorkerEnvironmentContext): Record<string, string> {
  const env: unknown = config.environment(context);
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new Error(`the environment of .factory/config.ts must return an object for the ${context.purpose}`);
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") throw new Error(`the environment of .factory/config.ts gives ${key} a non-string value`);
  }
  return env as Record<string, string>;
}

export function stopLimits(config: ResolvedConfig, workers: RoleChoice): StopLimits {
  const { agents, limits } = config;
  return {
    patience: limits.patience,
    subtaskWallClockMs: limits.subtaskWallClockMs,
    runWallClockMs: limits.runWallClockMs,
    subtaskTokens: agents[workers.agent].tokensPerSubtask,
    runTokens: agents[workers.agent].tokensPerRun,
  };
}
