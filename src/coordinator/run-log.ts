import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RoleChoice } from "../config/config.ts";
import type { AttemptOutcome, TokenUsage } from "../workers/types.ts";
import type { StopType } from "./stop-rules.ts";

export const RUN_LOG_VERSION = 1;

export type RunResult = "running" | "ready" | "draft" | "paused";

export type SubtaskState = "pending" | "merged" | "blocked";

export interface AttemptRecord {
  number: number;
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

export interface GateRecord {
  sha: string;
  accepted: boolean;
  reasons: string[];
  checks: CheckRecord[];
  criteria: CriterionRecord[];
}

export interface BlockRecord {
  type: StopType;
  reason: string;
  lastFailure?: string;
}

export interface SubtaskRecord {
  id: string;
  criteria: string[];
  branch: string;
  state: SubtaskState;
  reason?: string;
  block?: BlockRecord;
  attempts: AttemptRecord[];
  gate?: GateRecord;
}

export interface VerificationRecord {
  sha: string;
  passed: boolean;
  checks: CheckRecord[];
  criteria: CriterionRecord[];
  humanCriteria: HumanCriterionRecord[];
}

export interface PullRequestRecord {
  number: number;
  url: string;
  draft: boolean;
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
  agents: { workers: RoleChoice };
  subtasks: SubtaskRecord[];
  verification?: VerificationRecord;
  pullRequest?: PullRequestRecord;
}

export async function writeRunLog(path: string, log: RunLog): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  await writeFile(partial, `${JSON.stringify(log, null, 2)}\n`);
  await rename(partial, path);
}
