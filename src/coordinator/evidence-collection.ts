import { copyFile, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type { AppStart, EvidenceCommands } from "../config/config.ts";
import type { Worker } from "../workers/types.ts";
import { appLogPath, criterionLogPath, keepFailedOutput, type CheckOutput } from "./command-output.ts";
import { evidenceCommand, type EvidencePlan } from "./evidence.ts";
import { firstErrorLine } from "./failures.ts";
import type { CheckRecord, CriterionRecord, HumanCriterionRecord } from "./run-log.ts";
import { formatDuration } from "./stop-rules.ts";

export interface EvidenceResult {
  criteria: CriterionRecord[];
  human: HumanCriterionRecord[];
  appProblem?: string;
  appCheck?: CheckRecord;
}

export const READY_POLL_MS = 250;

export interface EvidenceContext {
  app: AppStart | undefined;
  commands: EvidenceCommands;
  attachmentsDir: string;
  recordingsDir?: string;
  runDir: string;
  label: string;
}

export async function collectEvidence(worker: Worker, plan: EvidencePlan, context: EvidenceContext): Promise<EvidenceResult> {
  if (plan.criteria.length === 0 && plan.human.length === 0) return { criteria: [], human: [] };
  const appProblem = context.app ? await startApp(worker, context.app, context) : null;
  if (appProblem !== null) return { criteria: [], human: [], appProblem: appProblem.problem, ...(appProblem.check ? { appCheck: appProblem.check } : {}) };
  const criteria: CriterionRecord[] = [];
  for (const item of plan.criteria) {
    const recording = item.evidence === "playwright" ? recordingOf(worker, item.id, context) : undefined;
    if (recording !== undefined) await rm(recording.source, { recursive: true, force: true });
    const result = await worker.exec(item.command);
    const passed = result.exitCode === 0;
    const output = passed ? {} : await keepFailedOutput(result, context.runDir, criterionLogPath(context.label, item.id));
    const evidenceFiles = recording === undefined ? [] : await keepRecording(worker, recording, context.runDir);
    criteria.push({
      id: item.id,
      evidence: item.evidence,
      command: item.command,
      exitCode: result.exitCode,
      passed,
      ...output,
      ...(evidenceFiles.length > 0 ? { evidenceFiles } : {}),
    });
  }
  const human: HumanCriterionRecord[] = [];
  for (const item of plan.human) {
    human.push({ id: item.id, reason: item.reason, attachments: await captureAttachments(worker, item.id, context) });
  }
  return { criteria, human };
}

export interface AppProblem {
  problem: string;
  check?: CheckRecord;
}

export const APP_START_CHECK = "app.start";

export const APP_OUTPUT_BYTES = 64 * 1024;

export interface AppStartOptions extends CheckOutput {
  onWaiting?: (ready: string) => void;
}

export async function startApp(worker: Worker, app: AppStart, options: AppStartOptions): Promise<AppProblem | null> {
  const started = await worker.exec(
    `dir=$(mktemp -d) || exit 1; { ( (${app.start}) 2>&1; echo $? >"$dir/code" ) | tail -c ${APP_OUTPUT_BYTES} >"$dir/output"; mv "$dir/code" "$dir/exit"; } >/dev/null 2>&1 & echo "$dir"`,
  );
  if (started.exitCode !== 0) return { problem: `the app did not start: ${app.start} exited with ${started.exitCode}` };
  const dir = started.stdout.trim();
  try {
    if (app.ready === undefined) return null;
    options.onWaiting?.(app.ready);
    const polls = Math.max(1, Math.ceil(app.readyTimeoutMs / READY_POLL_MS));
    for (let poll = 1; poll <= polls; poll += 1) {
      if (await isReady(worker, app.ready, app.readyTimeoutMs)) return null;
      const exitCode = await appExitCode(worker, dir);
      if (exitCode !== null && exitCode !== 0) return await exitedApp(worker, app, dir, exitCode, options);
      if (poll < polls) await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
    return { problem: `the app did not become ready: ${app.ready} kept failing for ${formatDuration(app.readyTimeoutMs)}` };
  } finally {
    await worker.exec(`rm -rf '${dir}'`).catch(() => undefined);
  }
}

async function appExitCode(worker: Worker, dir: string): Promise<number | null> {
  const read = await worker.exec(`cat '${dir}/exit' 2>/dev/null`);
  const text = read.stdout.trim();
  return read.exitCode === 0 && /^[0-9]+$/.test(text) ? Number(text) : null;
}

async function exitedApp(worker: Worker, app: AppStart, dir: string, exitCode: number, output: CheckOutput): Promise<AppProblem> {
  const { stdout } = await worker.exec(`cat '${dir}/output' 2>/dev/null`);
  const firstError = firstErrorLine(stdout);
  const kept = await keepFailedOutput({ exitCode, stdout, stderr: "" }, output.runDir, appLogPath(output.label));
  return {
    problem: `the app exited with ${exitCode} before it was ready${firstError === undefined ? "" : `: ${firstError}`}`,
    check: { name: APP_START_CHECK, command: app.start, exitCode, passed: false, ...(firstError !== undefined ? { firstError } : {}), ...kept },
  };
}

async function isReady(worker: Worker, ready: string, readyTimeoutMs: number): Promise<boolean> {
  try {
    return (await worker.exec(ready, { timeoutMs: readyTimeoutMs })).exitCode === 0;
  } catch (error) {
    if ((error as { killed?: boolean }).killed === true) return false;
    throw error;
  }
}

interface Recording {
  source: string;
  target: string;
}

function recordingOf(worker: Worker, id: string, context: EvidenceContext): Recording | undefined {
  const { attachments } = context.commands;
  if (context.recordingsDir === undefined || attachments === undefined) return undefined;
  return { source: join(worker.worktreePath, attachments), target: join(context.recordingsDir, id) };
}

async function keepRecording(worker: Worker, recording: Recording, runDir: string): Promise<string[]> {
  const { source, target } = recording;
  await rm(target, { recursive: true, force: true });
  const kept: string[] = [];
  if (await isFolderInside(source, worker.worktreePath)) {
    for (const file of (await filesIn(source)).sort()) {
      const copy = join(target, relative(source, file));
      await mkdir(dirname(copy), { recursive: true });
      await copyFile(file, copy);
      kept.push(relative(runDir, copy));
    }
  }
  await rm(source, { recursive: true, force: true });
  return kept;
}

async function isFolderInside(folder: string, root: string): Promise<boolean> {
  const entry = await lstat(folder).catch(() => null);
  if (entry === null || !entry.isDirectory()) return false;
  const [realFolder, realRoot] = await Promise.all([realpath(folder), realpath(root)]);
  return realFolder.startsWith(`${realRoot}${sep}`);
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

export async function filesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((entry) => {
      if (entry.isDirectory()) return filesIn(join(dir, entry.name));
      return entry.isFile() ? [join(dir, entry.name)] : [];
    }),
  );
  return nested.flat();
}
