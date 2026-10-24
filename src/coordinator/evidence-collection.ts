import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AppStart, EvidenceCommands } from "../config/config.ts";
import type { Worker } from "../workers/types.ts";
import { evidenceCommand, type EvidencePlan } from "./evidence.ts";
import type { CriterionRecord, HumanCriterionRecord } from "./run-log.ts";

export interface EvidenceResult {
  criteria: CriterionRecord[];
  human: HumanCriterionRecord[];
}

export interface EvidenceContext {
  app: AppStart | undefined;
  commands: EvidenceCommands;
  attachmentsDir: string;
}

export async function collectEvidence(worker: Worker, plan: EvidencePlan, context: EvidenceContext): Promise<EvidenceResult> {
  if (plan.criteria.length === 0 && plan.human.length === 0) return { criteria: [], human: [] };
  if (context.app) await startApp(worker, context.app);
  const criteria: CriterionRecord[] = [];
  for (const item of plan.criteria) {
    const result = await worker.exec(item.command);
    criteria.push({
      id: item.id,
      evidence: item.evidence,
      command: item.command,
      exitCode: result.exitCode,
      passed: result.exitCode === 0,
    });
  }
  const human: HumanCriterionRecord[] = [];
  for (const item of plan.human) {
    human.push({ id: item.id, reason: item.reason, attachments: await captureAttachments(worker, item.id, context) });
  }
  return { criteria, human };
}

async function startApp(worker: Worker, app: AppStart): Promise<void> {
  const result = await worker.exec(`(${app.start}) >/dev/null 2>&1 &`);
  if (result.exitCode !== 0) throw new Error(`the app did not start: ${app.start} exited with ${result.exitCode}`);
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
