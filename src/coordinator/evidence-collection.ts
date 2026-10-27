import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AppStart, EvidenceCommands } from "../config/config.ts";
import type { Worker } from "../workers/types.ts";
import { criterionLogPath, keepFailedOutput } from "./command-output.ts";
import { evidenceCommand, type EvidencePlan } from "./evidence.ts";
import type { CriterionRecord, HumanCriterionRecord } from "./run-log.ts";
import { formatDuration } from "./stop-rules.ts";

export interface EvidenceResult {
  criteria: CriterionRecord[];
  human: HumanCriterionRecord[];
  appProblem?: string;
}

export const READY_POLL_MS = 250;

export interface EvidenceContext {
  app: AppStart | undefined;
  commands: EvidenceCommands;
  attachmentsDir: string;
  runDir: string;
  label: string;
}

export async function collectEvidence(worker: Worker, plan: EvidencePlan, context: EvidenceContext): Promise<EvidenceResult> {
  if (plan.criteria.length === 0 && plan.human.length === 0) return { criteria: [], human: [] };
  const appProblem = context.app ? await startApp(worker, context.app) : null;
  if (appProblem !== null) return { criteria: [], human: [], appProblem };
  const criteria: CriterionRecord[] = [];
  for (const item of plan.criteria) {
    const result = await worker.exec(item.command);
    const passed = result.exitCode === 0;
    const output = passed ? {} : await keepFailedOutput(result, context.runDir, criterionLogPath(context.label, item.id));
    criteria.push({
      id: item.id,
      evidence: item.evidence,
      command: item.command,
      exitCode: result.exitCode,
      passed,
      ...output,
    });
  }
  const human: HumanCriterionRecord[] = [];
  for (const item of plan.human) {
    human.push({ id: item.id, reason: item.reason, attachments: await captureAttachments(worker, item.id, context) });
  }
  return { criteria, human };
}

async function startApp(worker: Worker, app: AppStart): Promise<string | null> {
  const started = await worker.exec(`(${app.start}) >/dev/null 2>&1 &`);
  if (started.exitCode !== 0) return `the app did not start: ${app.start} exited with ${started.exitCode}`;
  if (app.ready === undefined) return null;
  const polls = Math.max(1, Math.ceil(app.readyTimeoutMs / READY_POLL_MS));
  for (let poll = 1; poll <= polls; poll += 1) {
    if (await isReady(worker, app.ready, app.readyTimeoutMs)) return null;
    if (poll < polls) await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  return `the app did not become ready: ${app.ready} kept failing for ${formatDuration(app.readyTimeoutMs)}`;
}

async function isReady(worker: Worker, ready: string, readyTimeoutMs: number): Promise<boolean> {
  try {
    return (await worker.exec(ready, { timeoutMs: readyTimeoutMs })).exitCode === 0;
  } catch (error) {
    if ((error as { killed?: boolean }).killed === true) return false;
    throw error;
  }
}

async function captureAttachments(worker: Worker, id: string, context: EvidenceContext): Promise<string[]> {
  const { playwright, attachments } = context.commands;
  if (playwright === undefined || attachments === undefined) return [];
  const source = join(worker.worktreePath, attachments);
  await rm(source, { recursive: true, force: true });
  await worker.exec(evidenceCommand(playwright, id));
  const target = join(context.attachmentsDir, id);
  const kept: string[] = [];
  for (const file of await filesIn(source)) {
    await mkdir(target, { recursive: true });
    await copyFile(file, join(target, basename(file)));
    kept.push(join("attachments", id, basename(file)));
  }
  await rm(source, { recursive: true, force: true });
  return kept;
}

async function filesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((entry) => (entry.isDirectory() ? filesIn(join(dir, entry.name)) : [join(dir, entry.name)])),
  );
  return nested.flat();
}
