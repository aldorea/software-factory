import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RoleChoice } from "../config/config.ts";
import type { WorkerLayerFailureKind, WorkerLayerStage } from "../workers/failures.ts";
import type { AgentKind, AttemptOutcome, TokenUsage } from "../workers/types.ts";
import type { StopType } from "./stop-rules.ts";

export const RUN_LOG_VERSION = 1;

export type RunResult = "running" | "ready" | "draft" | "paused";

export type SubtaskState = "pending" | "working" | "gating" | "merged" | "blocked" | "interrupted" | "not-started";

export const BLOCK_TYPES = ["scope", "design-question", "patience", "limit", "environment"] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

export interface AttemptRecord {
  number: number;
  agent: RoleChoice;
  outcome: AttemptOutcome["kind"];
  detail?: string;
  failure?: { signature: string; description: string };
  usage: TokenUsage;
  logPath: string;
  startedAt: string;
  endedAt: string;
}

export interface CheckRecord {
  name: string;
  command: string;
  exitCode: number;
  passed: boolean;
  firstError?: string;
}

export interface CriterionRecord {
  id: string;
  evidence: "playwright" | "request";
  command: string;
  exitCode: number;
  passed: boolean;
}

export interface HumanCriterionRecord {
  id: string;
  reason: string;
  attachments: string[];
}

export interface VerifierRecord {
  id: string;
  verdict: "accept" | "refute" | "error";
  reason?: string;
  logPath: string;
}

export interface GateRecord {
  sha: string;
  accepted: boolean;
  reasons: string[];
  checks: CheckRecord[];
  criteria: CriterionRecord[];
  verifier: VerifierRecord[];
}

export interface BlockRecord {
  type: StopType | "scope" | "design-question" | "environment";
  reason: string;
  lastFailure?: string;
}

export interface FollowUpRecord {
  round: number;
  criteria: string[];
  failure: string;
  outcome: "merged" | "blocked" | "interrupted" | "paused";
}

export interface CarriedLoopRecord {
  firstAttempt: number;
  elapsedMs: number;
}

export interface SubtaskRecord {
  id: string;
  criteria: string[];
  branch: string;
  state: SubtaskState;
  blockType?: BlockType;
  reason?: string;
  block?: BlockRecord;
  conflictFiles?: string[];
  followUps?: FollowUpRecord[];
  attempts: AttemptRecord[];
  carriedLoop?: CarriedLoopRecord;
  usage: TokenUsage;
  gate?: GateRecord;
  gateRejections: number;
  verifierRejections: number;
  conflicts: number;
  scopeExtensions: string[];
}

export interface VerificationRecord {
  sha: string;
  passed: boolean;
  checks: CheckRecord[];
  criteria: CriterionRecord[];
  humanCriteria: HumanCriterionRecord[];
  environment?: string;
}

export interface EvidenceBranchRecord {
  branch: string;
  commit?: string;
  repositoryUrl?: string;
  failure?: string;
}

export interface PullRequestRecord {
  number: number;
  url: string;
  draft: boolean;
}

export interface AgentChangeRecord {
  role: "workers" | "verifier";
  from: RoleChoice;
  to: RoleChoice;
  at: string;
}

export interface AgentsRecord {
  workers: RoleChoice;
  verifier?: RoleChoice;
  changes: AgentChangeRecord[];
}

export interface CriteriaRecord {
  passing: string[];
  blocked: string[];
  human: string[];
  pending: string[];
}

export interface CostRecord {
  usage: TokenUsage;
  perAgent: Partial<Record<AgentKind, TokenUsage>>;
  attempts: number;
  wallClockMs: number;
  pausedMs: number;
}

export interface FrictionRecord {
  blocks: Record<BlockType, number>;
  scopeExtensions: number;
  gateRejections: number;
  verifierRejections: number;
  integrationConflicts: number;
}

export interface WorkerLayerFailureRecord {
  kind: WorkerLayerFailureKind;
  stage: WorkerLayerStage;
  subtask: string | null;
  message: string;
  at: string;
}

export interface PauseRecord {
  agent: AgentKind;
  at: string;
}

export interface RunLog {
  version: typeof RUN_LOG_VERSION;
  runId: string;
  issue: number;
  integrationBranch: string;
  startedAt: string;
  endedAt?: string;
  result: RunResult;
  pauseReason?: string;
  resetsAt?: string;
  pauses?: PauseRecord[];
  maxParallel?: number;
  agents: AgentsRecord;
  criteria: CriteriaRecord;
  cost: CostRecord;
  friction: FrictionRecord;
  workerLayerFailures: WorkerLayerFailureRecord[];
  subtasks: SubtaskRecord[];
  verification?: VerificationRecord;
  evidence?: EvidenceBranchRecord;
  pullRequest?: PullRequestRecord;
}

export type ParsedRunLog = { ok: true; log: RunLog } | { ok: false; problem: string };

export function parseRunLog(text: string): ParsedRunLog {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { ok: false, problem: `run.json is not valid JSON: ${(error as Error).message}` };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, problem: "run.json must hold an object" };
  }
  const version = (data as { version?: unknown }).version;
  if (version !== RUN_LOG_VERSION) {
    return { ok: false, problem: `run.json has version ${String(version)}, expected ${RUN_LOG_VERSION}` };
  }
  return { ok: true, log: data as RunLog };
}

export async function writeRunLog(path: string, log: RunLog): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  await writeFile(partial, `${JSON.stringify(log, null, 2)}\n`);
  await rename(partial, path);
}
