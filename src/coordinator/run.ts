import { join } from "node:path";
import { emptyUsage } from "../workers/agent-adapter.ts";
import { WorkerLayerError } from "../workers/failures.ts";
import { runId as makeRunId, runResult } from "./decisions.ts";
import { testFilesAt } from "./diff.ts";
import { requestCheckPaths } from "./gate.ts";
import { includeDefaultBranch } from "./default-branch.ts";
import { verifyIntegration } from "./integrated-verification.ts";
import { adjustMaxParallel } from "./parallelism.ts";
import type { RunPorts } from "./ports.ts";
import { prepare } from "./prepare.ts";
import { progressLines } from "./progress.ts";
import { publicationNotification, publishRun, type PublicationResult } from "./publication.ts";
import { resumedLog } from "./resume.ts";
import { paused, type RunContext, type RunRequest } from "./run-context.ts";
import { latestRunLog, mergedSubtasks, readRunLogs, runBaseSha } from "./run-history.ts";
import { RUN_LOG_VERSION, writeRunLog, type RunLog, type SubtaskRecord } from "./run-log.ts";
import { applyTotals, emptyCost, emptyFriction } from "./run-totals.ts";
import { inWaves, Lock } from "./slots.ts";
import { startSubtask } from "./subtask-work.ts";

export type { RunRequest } from "./run-context.ts";
export { mergeMessage } from "./subtask-work.ts";

export { REMOTE } from "../git/repo.ts";

export interface RunReport {
  result: RunLog["result"];
  publication: PublicationResult;
  issueTitle: string;
  runLogPath: string;
  log: RunLog;
}

export async function runIssue(request: RunRequest, ports: RunPorts): Promise<RunReport> {
  const prepared = await prepare(request, ports);
  const { issue, branch, defaultBranch, spec, plan, parallelism, workers, verifier, tester, humanCriteria } = prepared;
  const subtasks = plan.base ? [plan.base, ...spec.subtasks] : spec.subtasks;
  const now = ports.clock.now();
  const logsDir = join(request.repoDir, ".factory", "logs");
  const fresh: RunLog = {
    version: RUN_LOG_VERSION,
    runId: makeRunId(request.issue, now),
    issue: request.issue,
    integrationBranch: branch,
    startedAt: now.toISOString(),
    attemptIdleTimeoutMs: prepared.config.limits.attemptIdleTimeoutMs,
    result: "running",
    agents: { workers, verifier, tester, changes: [] },
    criteria: { passing: [], blocked: [], human: humanCriteria, pending: [] },
    cost: emptyCost(),
    friction: emptyFriction(),
    workerLayerFailures: [],
    subtasks: subtasks.map((subtask) => ({
      id: subtask.id,
      criteria: subtask.criteria,
      branch: subtaskBranch(branch, subtask.id),
      state: "pending",
      attempts: [],
      usage: emptyUsage(),
      gateRejections: 0,
      verifierRejections: 0,
      conflicts: 0,
      scopeExtensions: [],
    })),
  };
  const log = resumedLog({
    fresh,
    previous: await latestRunLog(logsDir, request.issue),
    merged: await mergedSubtasks(request.repoDir, branch),
    now,
  });
  log.maxParallel = adjustMaxParallel((await readRunLogs(logsDir)).logs, workers.agent, parallelism);
  const runDir = join(logsDir, log.runId);
  const runLogPath = join(runDir, "run.json");
  const records = new Map<string, SubtaskRecord>(log.subtasks.map((record) => [record.id, record]));
  const runStartSha = await runBaseSha(request.repoDir, branch);
  const saveLock = new Lock();
  let reported: RunLog | null = null;
  const save = () =>
    saveLock.exclusive(async () => {
      applyTotals(log, ports.clock.now());
      await writeRunLog(runLogPath, log);
      for (const line of progressLines(reported, log, prepared.config)) ports.progress?.(line);
      reported = structuredClone(log);
      ports.snapshot?.(reported);
    });
  const context: RunContext = {
    request,
    ports,
    prepared,
    log,
    runDir,
    startedAt: new Date(Date.parse(log.startedAt) + log.cost.pausedMs),
    runStartSha,
    existingTestPaths: await testFilesAt(request.repoDir, runStartSha),
    requestChecks: spec.base ? requestCheckPaths(spec) : [],
    records,
    scopes: new Map(
      subtasks.map((subtask) => [subtask.id, [...subtask.scope, ...(records.get(subtask.id)?.scopeExtensions ?? [])]]),
    ),
    budgets: new Map(),
    gitLock: new Lock(),
    conflicted: log.subtasks.some((record) => record.state === "blocked" && record.conflictFiles !== undefined),
    verifications: 0,
    save,
    async noteFailure(error, subtaskId) {
      if (!(error instanceof WorkerLayerError)) throw error;
      log.workerLayerFailures.push({
        kind: error.kind,
        stage: error.stage,
        subtask: subtaskId,
        message: error.message,
        at: ports.clock.now().toISOString(),
      });
      await save();
    },
  };
  await save();

  await inWaves(plan, log.maxParallel, (subtask, slot) => startSubtask(context, subtask, slot));
  if (!paused(context)) await verifyIntegration(context, subtasks);
  await includeDefaultBranch(context, subtasks);
  log.result = runResult(log);
  log.endedAt = ports.clock.now().toISOString();
  await save();

  const publication = await publishRun({
    repoDir: request.repoDir,
    issue,
    defaultBranch,
    log,
    runDir,
    github: ports.github,
    clock: ports.clock,
    sleep: ports.sleep,
    progress: ports.progress,
    save,
  });
  await ports.notifier.notify(publicationNotification(issue, log, publication));
  return { result: log.result, publication, issueTitle: issue.title, runLogPath, log };
}

export function subtaskBranch(integration: string, subtaskId: string): string {
  return `factory-subtask/${integration.replace(/^factory\//, "")}/${subtaskId}`;
}
