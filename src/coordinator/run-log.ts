import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RoleChoice } from "../config/config.ts";
import type { AttemptOutcome, TokenUsage } from "../workers/types.ts";

export const RUN_LOG_VERSION = 1;

export type RunResult = "running" | "ready" | "draft" | "paused";

export type SubtaskState = "pending" | "working" | "gating" | "merged" | "blocked";

export interface AttemptRecord {
  number: number;
  outcome: AttemptOutcome["kind"];
  detail?: string;
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
}

export interface GateRecord {
  sha: string;
  accepted: boolean;
  reasons: string[];
  checks: CheckRecord[];
}

export interface SubtaskRecord {
  id: string;
  criteria: string[];
  branch: string;
  state: SubtaskState;
  reason?: string;
  attempts: AttemptRecord[];
  gate?: GateRecord;
}

export interface VerificationRecord {
  sha: string;
  passed: boolean;
  checks: CheckRecord[];
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
