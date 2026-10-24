import { join } from "node:path";
import type { WorkerEnvironmentContext } from "../config/config.ts";
import { createBranchAt, deleteBranch } from "../git/repo.ts";
import { inStage } from "../workers/failures.ts";
import type { Worker } from "../workers/types.ts";
import { collectEvidence, type EvidenceResult } from "./evidence-collection.ts";
import type { EvidencePlan } from "./evidence.ts";
import { firstErrorLine } from "./failures.ts";
import { environment, type RunContext } from "./run-context.ts";
import type { CheckRecord } from "./run-log.ts";

export interface CheckRequest {
  label: string;
  sha: string;
  purpose: WorkerEnvironmentContext;
  plan: EvidencePlan;
  subtaskId: string | null;
}

export interface CheckOutcome extends EvidenceResult {
  checks: CheckRecord[];
}

export async function checksOn(context: RunContext, request: CheckRequest): Promise<CheckOutcome | null> {
  const { repoDir } = context.request;
  const { config } = context.prepared;
  const id = context.log.runId;
  const checkBranch = `factory-check/${id}/${request.label}`;
  const env = environment(config, request.purpose);
  const worker = await context.gitLock
    .exclusive(async () => {
      await createBranchAt(repoDir, checkBranch, request.sha);
      return inStage("start", () =>
        context.ports.runner.start({
          id: `${id}-${request.label}`,
          repoDir,
          baseRef: checkBranch,
          branch: checkBranch,
          image: config.image,
          env,
          logDir: context.runDir,
        }),
      );
    })
    .catch(async (error: unknown) => {
      await context.gitLock.exclusive(() => deleteBranch(repoDir, checkBranch)).catch(() => undefined);
      await context.noteFailure(error, request.subtaskId);
      return null;
    });
  if (worker === null) return null;
  let outcome: CheckOutcome | null = null;
  let preserved = false;
  try {
    outcome = await checksIn(context, worker, request.plan);
  } catch (error) {
    await context.noteFailure(error, request.subtaskId);
  } finally {
    try {
      preserved = (await context.gitLock.exclusive(() => inStage("close", () => worker.close()))).preservedWorktreePath !== undefined;
    } catch (error) {
      await context.noteFailure(error, request.subtaskId);
    }
  }
  if (!preserved) await context.gitLock.exclusive(() => deleteBranch(repoDir, checkBranch));
  return outcome;
}

async function checksIn(context: RunContext, worker: Worker, plan: EvidencePlan): Promise<CheckOutcome> {
  const { config } = context.prepared;
  const checks: CheckRecord[] = [];
  for (const check of config.checks) {
    const result = await inStage("exec", () => worker.exec(check.command));
    const passed = result.exitCode === 0;
    const firstError = passed ? undefined : firstErrorLine(`${result.stderr}\n${result.stdout}`);
    checks.push({
      name: check.name,
      command: check.command,
      exitCode: result.exitCode,
      passed,
      ...(firstError !== undefined ? { firstError } : {}),
    });
  }
  const evidence = await collectEvidence(worker, plan, {
    app: config.app,
    commands: config.evidence,
    attachmentsDir: join(context.runDir, "attachments"),
  });
  return { checks, ...evidence };
}
