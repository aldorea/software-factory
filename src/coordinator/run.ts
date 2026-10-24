import { join } from "node:path";
import type { ResolvedConfig, Role, RoleChoice, WorkerEnvironmentContext } from "../config/config.ts";
import { loadConfig } from "../config/load.ts";
import { chooseRole, choiceProblems, credentialProblem, CREDENTIAL_VARIABLES, ROLES } from "../config/roles.ts";
import {
  createBranchAt,
  deleteBranch,
  integrationBranch,
  mergeBranch,
  moveBranch,
  pushBranch,
  showFile,
  withBranchWorktree,
} from "../git/repo.ts";
import type { Issue, PullRequest } from "../github/github.ts";
import { readPromptTemplate, renderTemplate } from "../prompts/template.ts";
import { criteriaText, issueCriteria } from "../spec/issue.ts";
import { parseSpec, validateSpec, type Spec, type Subtask } from "../spec/spec.ts";
import { emptyUsage } from "../workers/agent-adapter.ts";
import { inStage, WorkerLayerError } from "../workers/failures.ts";
import { revParse } from "../workers/git.ts";
import type { AgentKind } from "../workers/types.ts";
import { approvalProblem, runId as makeRunId, runResult, verificationPassed, verifiedDecision } from "./decisions.ts";
import { changedPaths, testFilesAt } from "./diff.ts";
import { evidenceProblems, gatePlan, integrationPlan, type EvidencePlan } from "./evidence.ts";
import { collectEvidence, type EvidenceResult } from "./evidence-collection.ts";
import { firstErrorLine } from "./failures.ts";
import { followUpFailure, followUpStop, followUpTasks, verificationSignature } from "./follow-up.ts";
import { gateDecision, protectedFor, requestCheckPaths, type GateDecision } from "./gate.ts";
import type { RunPorts } from "./ports.ts";
import { renderPullRequest } from "./pull-request.ts";
import { resumedLog } from "./resume.ts";
import { adjustMaxParallel, type ParallelismBounds } from "./parallelism.ts";
import { latestRunLog, mergedSubtasks, readRunLogs, runBaseSha, SUBTASK_TRAILER } from "./run-history.ts";
import { dependencyProblem, schedule, type Schedule } from "./schedule.ts";
import { decideScopeExtension, type ScopeExtensionDecision } from "./scope-extension.ts";
import { Lock, inWaves } from "./slots.ts";
import {
  RUN_LOG_VERSION,
  writeRunLog,
  type BlockType,
  type CheckRecord,
  type FollowUpRecord,
  type RunLog,
  type SubtaskRecord,
  type SubtaskState,
} from "./run-log.ts";
import { applyTotals, emptyCost, emptyFriction } from "./run-totals.ts";
import { agentTokens, type StopLimits, type StopType } from "./stop-rules.ts";
import { attemptSubtask, type LoopResult, type PlanLimitHit } from "./subtask-loop.ts";
import { judgeTests, NO_JUDGMENT } from "./test-judgment.ts";

export const REMOTE = "origin";
export const PULL_REQUEST_BASE = "main";

export interface RunRequest {
  repoDir: string;
  issue: number;
  credentials: Partial<Record<AgentKind, string>>;
  roles?: Partial<Record<Role, RoleChoice>>;
}

export interface RunReport {
  result: RunLog["result"];
  pullRequest: PullRequest;
  runLogPath: string;
  log: RunLog;
}

interface Prepared {
  config: ResolvedConfig;
  issue: Issue;
  branch: string;
  spec: Spec;
  plan: Schedule;
  parallelism: ParallelismBounds;
  humanCriteria: string[];
  workers: RoleChoice;
  verifier: RoleChoice;
  credential: string;
}

export async function runIssue(request: RunRequest, ports: RunPorts): Promise<RunReport> {
  const prepared = await prepare(request, ports);
  const { config, issue, branch, spec, plan, parallelism, workers, verifier, humanCriteria } = prepared;
  const subtasks = plan.base ? [plan.base, ...spec.subtasks] : spec.subtasks;
  const now = ports.clock.now();
  const logsDir = join(request.repoDir, ".factory", "logs");
  const fresh: RunLog = {
    version: RUN_LOG_VERSION,
    runId: makeRunId(request.issue, now),
    issue: request.issue,
    integrationBranch: branch,
    startedAt: now.toISOString(),
    result: "running",
    agents: { workers, verifier, changes: [] },
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
  const maxParallel = log.maxParallel;
  const id = log.runId;
  const startedAt = new Date(Date.parse(log.startedAt) + log.cost.pausedMs);
  const runDir = join(logsDir, id);
  const runLogPath = join(runDir, "run.json");
  const records = new Map<string, SubtaskRecord>(log.subtasks.map((record) => [record.id, record]));
  const runStartSha = await runBaseSha(request.repoDir, branch);
  const existingTestPaths = await testFilesAt(request.repoDir, runStartSha);
  const requestChecks = spec.base ? requestCheckPaths(spec) : [];
  const saveLock = new Lock();
  const save = () =>
    saveLock.exclusive(async () => {
      applyTotals(log, ports.clock.now());
      await writeRunLog(runLogPath, log);
    });
  await save();

  const gitLock = new Lock();
  const scopes = new Map<string, string[]>(
    subtasks.map((subtask) => [subtask.id, [...subtask.scope, ...(records.get(subtask.id)?.scopeExtensions ?? [])]]),
  );
  const extendScope = (subtask: Subtask, requested: string[]): ScopeExtensionDecision => {
    const scope = scopes.get(subtask.id) as string[];
    const wave = plan.waves.find((members) => members.some((member) => member.id === subtask.id)) ?? [];
    const decision = decideScopeExtension({
      requested,
      scope,
      waveScopes: wave
        .filter((member) => member.id !== subtask.id)
        .map((member) => ({ subtask: member.id, scope: scopes.get(member.id) as string[] })),
      protectedPaths: protectedFor(subtask.id === plan.base?.id, config.protectedPaths),
    });
    if (decision.kind === "extend") {
      scope.push(...decision.paths);
      (records.get(subtask.id) as SubtaskRecord).scopeExtensions.push(...decision.paths);
    }
    return decision;
  };

  const noteFailure = async (error: unknown, subtaskId: string | null) => {
    if (!(error instanceof WorkerLayerError)) throw error;
    log.workerLayerFailures.push({
      kind: error.kind,
      stage: error.stage,
      subtask: subtaskId,
      message: error.message,
      at: ports.clock.now().toISOString(),
    });
    await save();
  };

  const checksOn = async (
    label: string,
    sha: string,
    context: WorkerEnvironmentContext,
    plan: EvidencePlan,
    subtaskId: string | null,
  ) => {
    const checkBranch = `factory-check/${id}/${label}`;
    const env = environment(config, context);
    const started = await gitLock
      .exclusive(async () => {
        await createBranchAt(request.repoDir, checkBranch, sha);
        return inStage("start", () =>
          ports.runner.start({ id: `${id}-${label}`, repoDir: request.repoDir, baseRef: checkBranch, branch: checkBranch, image: config.image, env, logDir: runDir }),
        );
      })
      .then(
        (worker) => ({ worker }),
        async (error: unknown) => {
          await gitLock.exclusive(() => deleteBranch(request.repoDir, checkBranch)).catch(() => undefined);
          await noteFailure(error, subtaskId);
          return { worker: null };
        },
      );
    if (started.worker === null) return null;
    const { worker } = started;
    let checks: CheckRecord[] | null = [];
    let evidence: EvidenceResult = { criteria: [], human: [] };
    let preserved = false;
    try {
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
      evidence = await collectEvidence(worker, plan, {
        app: config.app,
        commands: config.evidence,
        attachmentsDir: join(runDir, "attachments"),
      });
    } catch (error) {
      checks = null;
      await noteFailure(error, subtaskId);
    } finally {
      try {
        preserved = (await gitLock.exclusive(() => inStage("close", () => worker.close()))).preservedWorktreePath !== undefined;
      } catch (error) {
        await noteFailure(error, subtaskId);
      }
    }
    if (!preserved) await gitLock.exclusive(() => deleteBranch(request.repoDir, checkBranch));
    if (checks === null) return null;
    return { checks, ...evidence };
  };

  const pauseRun = (limit: PlanLimitHit) => {
    if (log.pauseReason !== undefined) return;
    log.pauseReason = `the plan limit of ${limit.agent} was reached: ${limit.message}`;
    log.pauses = [...(log.pauses ?? []), { agent: limit.agent, at: ports.clock.now().toISOString() }];
    if (limit.resetsAt !== undefined) log.resetsAt = limit.resetsAt.toISOString();
  };

  let conflicted = false;
  const stateOf = (subtaskId: string) => (records.get(subtaskId) as SubtaskRecord).state;

  const notStartedReason = (subtask: Subtask): string | null => {
    if (plan.base && subtask.id !== plan.base.id && stateOf(plan.base.id) !== "merged") {
      return `It did not start because the base subtask ${plan.base.id} is blocked.`;
    }
    if (conflicted) return "It did not start because the run stopped on a merge conflict.";
    const states = new Map<string, SubtaskState>([...records].map(([subtaskId, record]) => [subtaskId, record.state]));
    return dependencyProblem(subtask, states);
  };

  const startSubtask = async (subtask: Subtask, slot: number) => {
    const record = records.get(subtask.id) as SubtaskRecord;
    if (log.pauseReason !== undefined || record.state === "merged") return;
    const reason = notStartedReason(subtask);
    if (reason !== null) {
      record.state = "not-started";
      record.reason = reason;
      await save();
      return;
    }
    await work(subtask, slot, null);
  };

  const work = async (subtask: Subtask, slot: number, followUp: FollowUpRun | null): Promise<void> => {
    const record = records.get(subtask.id) as SubtaskRecord;
    const label = followUp ? `${subtask.id}-followup-${followUp.round}` : subtask.id;
    if (followUp) {
      await gitLock.exclusive(async () => moveBranch(request.repoDir, record.branch, await revParse(request.repoDir, branch)));
    }
    const gate = async (attempt: number): Promise<GateDecision | PlanLimitHit | null> => {
      const sha = await revParse(request.repoDir, record.branch);
      const gated = await checksOn(
        `${label}-gate-${attempt}`,
        sha,
        { purpose: "gate", subtask: subtask.id, slot },
        gatePlan(spec, subtask.criteria, config.evidence),
        record.id,
      );
      if (gated === null) return null;
      const { checks, criteria } = gated;
      const checked = gateDecision({
        changes: await changedPaths(request.repoDir, branch, sha),
        scope: scopes.get(subtask.id) as string[],
        protectedPaths: config.protectedPaths,
        isBase: subtask.id === plan.base?.id,
        existingTestPaths,
        authorizedTestChanges: subtask.testChanges,
        requestCheckPaths: requestChecks,
        checks,
        criteria,
      });
      const judgment = checked.accepted
        ? await judgeTests(ports.verifier, {
            repoDir: request.repoDir,
            integrationBranch: followUp ? runStartSha : branch,
            sha,
            criteria,
            texts: criteriaText(issue.body),
            logDir: runDir,
            label: `${label}-attempt-${attempt}`,
          })
        : NO_JUDGMENT;
      if (judgment.planLimit !== undefined) {
        return { kind: "plan-limit", agent: verifier.agent, ...judgment.planLimit };
      }
      const decision = verifiedDecision(checked, judgment);
      const reasons = decision.rejections.filter((rejection) => rejection.kind !== "verifier").map((rejection) => rejection.message);
      record.gate = { sha, accepted: decision.accepted, reasons, checks, criteria, verifier: judgment.records };
      return decision;
    };
    const runTokens = () =>
      agentTokens(log.subtasks.flatMap((entry) => entry.attempts), workers.agent);

    record.state = "working";
    await save();
    const worked = await workInWorker(request, ports, prepared, { ...subtask, scope: [...(scopes.get(subtask.id) as string[])] }, runDir, slot, gitLock, {
      record,
      startedAt,
      gate,
      runTokens,
      extendScope: (requested) => extendScope(subtask, requested),
      save,
      paused: () => log.pauseReason !== undefined,
      workerId: workerId(request.issue, label, record),
      ...(followUp ? { followUp: followUp.text } : {}),
    });
    const unclassified = worked.failures.find((failure) => !(failure instanceof WorkerLayerError));
    if (unclassified !== undefined) throw unclassified;
    for (const failure of worked.failures) await noteFailure(failure, record.id);
    const loop = worked.result;

    let outcome: FollowUpRecord["outcome"] = "merged";
    if (loop === null || loop.kind === "interrupted") {
      outcome = "interrupted";
      record.state = "interrupted";
      record.reason =
        loop === null
          ? "A failure of the worker layer stopped it before its attempt ended."
          : "A failure of the worker layer stopped its gate.";
    } else if (loop.kind === "accepted") {
      const merged = await gitLock.exclusive(() =>
        withBranchWorktree(request.repoDir, branch, (worktree) =>
          mergeBranch(worktree, record.branch, mergeMessage(request.issue, subtask.id)),
        ),
      );
      if (merged.kind === "merged") record.state = "merged";
      else {
        outcome = "blocked";
        conflicted = true;
        record.conflicts += 1;
        record.conflictFiles = merged.files;
        record.state = "blocked";
        record.reason = `Its merge into ${branch} conflicts in ${merged.files.join(", ")}.`;
      }
    } else if (loop.kind === "reported") {
      outcome = "blocked";
      record.state = "blocked";
      record.blockType = loop.type;
      record.reason = loop.reason;
      record.block = { type: loop.type, reason: loop.reason };
    } else if (loop.kind === "paused") {
      outcome = "paused";
      if (loop.limit !== undefined) pauseRun(loop.limit);
      if (followUp) record.state = "merged";
    } else {
      outcome = "blocked";
      record.state = "blocked";
      record.blockType = blockTypeOf(loop.stop.type);
      record.reason = loop.stop.reason;
      record.block = {
        type: loop.stop.type,
        reason: loop.stop.reason,
        ...(loop.lastFailure !== undefined ? { lastFailure: loop.lastFailure } : {}),
      };
    }
    if (followUp) {
      record.followUps = [
        ...(record.followUps ?? []),
        { round: followUp.round, criteria: followUp.criteria, failure: followUp.text, outcome },
      ];
    }
    await save();
  };

  await inWaves(plan, maxParallel, startSubtask);

  if (log.pauseReason === undefined) {
    const signatures: string[] = [];
    for (let round = 1; ; round += 1) {
      const sha = await revParse(request.repoDir, branch);
      const verified = await checksOn(
        round === 1 ? "verification" : `verification-${round}`,
        sha,
        { purpose: "verification", subtask: null, slot: 0 },
        integrationPlan(spec, config.evidence),
        null,
      );
      if (verified === null) {
        delete log.verification;
        break;
      }
      const { checks, criteria, human } = verified;
      const passed = verificationPassed(checks, criteria);
      log.verification = { sha, passed, checks, criteria, humanCriteria: human };
      if (passed || conflicted) break;
      const tasks = followUpTasks(subtasks, criteria, stateOf);
      if (tasks.length === 0) break;
      signatures.push(verificationSignature(criteria));
      const stop = followUpStop(signatures, stopLimits(config, workers));
      if (stop) {
        for (const task of tasks) {
          const record = records.get(task.subtask.id) as SubtaskRecord;
          record.state = "blocked";
          record.blockType = blockTypeOf(stop.type);
          record.reason = stop.reason;
          record.block = { type: stop.type, reason: stop.reason };
        }
        await save();
        break;
      }
      const texts = criteriaText(issue.body);
      let merged = false;
      for (const task of tasks) {
        const followUp: FollowUpRun = {
          round,
          criteria: task.criteria,
          text: followUpFailure(sha, task, { checks, criteria }, texts),
        };
        await work(task.subtask, 0, followUp);
        const outcome = (records.get(task.subtask.id) as SubtaskRecord).followUps?.at(-1)?.outcome;
        if (outcome === "merged") merged = true;
        if (log.pauseReason !== undefined || conflicted) break;
      }
      if (!merged || log.pauseReason !== undefined || conflicted) break;
    }
    if (log.verification && log.verification.sha !== (await revParse(request.repoDir, branch))) delete log.verification;
  }
  log.result = runResult(log);
  log.endedAt = ports.clock.now().toISOString();
  await save();

  await pushBranch(request.repoDir, REMOTE, branch);
  const text = renderPullRequest(issue, log);
  const draft = log.result !== "ready";
  const existing = await ports.github.findPullRequest(branch, PULL_REQUEST_BASE);
  const pullRequest = existing
    ? await ports.github.updatePullRequest(existing.number, { ...text, draft })
    : await ports.github.createPullRequest({ ...text, head: branch, base: PULL_REQUEST_BASE, draft });
  log.pullRequest = { number: pullRequest.number, url: pullRequest.url, draft: pullRequest.draft };
  await save();

  await ports.notifier.notify({
    title: `factory run #${request.issue}`,
    message: notificationMessage(log, issue.title),
    url: pullRequest.url,
  });
  return { result: log.result, pullRequest, runLogPath, log };
}

async function prepare(request: RunRequest, ports: RunPorts): Promise<Prepared> {
  const branch = await integrationBranch(request.repoDir, request.issue);
  const specPath = `specs/${request.issue}.md`;
  const specText = await showFile(request.repoDir, branch, specPath);
  if (specText === null) throw new Error(`${specPath} does not exist on ${branch}`);
  const issue = await ports.github.readIssue(request.issue);
  const problem = approvalProblem(request.issue, specText, issue.body);
  if (problem !== null) throw new Error(problem);

  const config = await loadConfig(request.repoDir);
  const parsed = parseSpec(specText);
  if (!parsed.ok) throw new Error(`${specPath} is invalid: ${parsed.problems.join("; ")}`);
  const problems = validateSpec(parsed.spec, {
    issueCriteria: issueCriteria(issue.body) ?? [],
    protectedPaths: config.protectedPaths,
  });
  if (problems.length > 0) throw new Error(`${specPath} is invalid: ${problems.join("; ")}`);
  const missingEvidence = evidenceProblems(parsed.spec, config.evidence);
  if (missingEvidence.length > 0) throw new Error(`${specPath} cannot be verified: ${missingEvidence.join("; ")}`);
  const humanCriteria = Object.entries(parsed.spec.criteria)
    .filter(([, evidence]) => evidence.evidence === "human")
    .map(([id]) => id);
  const plan = schedule(parsed.spec);

  const asksVerifier = Object.values(parsed.spec.criteria).some((criterion) => criterion.evidence === "playwright");
  const roles = chosenRoles(request, config, { workers: true, verifier: asksVerifier });
  const { workers, verifier } = roles;
  const credential = request.credentials[workers.agent] as string;
  const limits = config.agents[workers.agent];
  const parallelism = { start: limits.maxParallel, ceiling: limits.maxParallelCeiling };
  return { config, issue, branch, spec: parsed.spec, plan, parallelism, humanCriteria, workers, verifier, credential };
}

function chosenRoles(
  request: RunRequest,
  config: ResolvedConfig,
  needsCredential: Record<Role, boolean>,
): Record<Role, RoleChoice> {
  const problems: string[] = [];
  const roles: Partial<Record<Role, RoleChoice>> = {};
  for (const role of ROLES) {
    const chosen = chooseRole({ role, ...optional("flag", request.roles?.[role]), ...optional("fallback", config.roles[role]) });
    if (!chosen.ok) {
      problems.push(chosen.problem);
      continue;
    }
    const invalid = choiceProblems(role, chosen.choice);
    const missing = needsCredential[role] ? credentialProblem(role, chosen.choice, request.credentials) : null;
    problems.push(...invalid, ...(invalid.length === 0 && missing !== null ? [missing] : []));
    roles[role] = chosen.choice;
  }
  if (problems.length > 0) throw new Error(problems.join("; "));
  return roles as Record<Role, RoleChoice>;
}

function optional<K extends string, T>(key: K, value: T | undefined): Partial<Record<K, T>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, T>);
}

interface Worked {
  result: LoopResult | null;
  failures: unknown[];
}

interface FollowUpRun {
  round: number;
  criteria: string[];
  text: string;
}

interface LoopWiring {
  record: SubtaskRecord;
  workerId: string;
  followUp?: string;
  startedAt: Date;
  gate: (attempt: number) => Promise<GateDecision | PlanLimitHit | null>;
  runTokens: () => number;
  extendScope: (requested: string[]) => ScopeExtensionDecision;
  save: () => Promise<void>;
  paused: () => boolean;
}

async function workInWorker(
  request: RunRequest,
  ports: RunPorts,
  prepared: Prepared,
  subtask: Subtask,
  runDir: string,
  slot: number,
  gitLock: Lock,
  wiring: LoopWiring,
): Promise<Worked> {
  const { config, issue, branch, workers, credential } = prepared;
  const failures: unknown[] = [];
  const worker = await gitLock
    .exclusive(() =>
      inStage("start", () =>
        ports.runner.start({
          id: wiring.workerId,
          repoDir: request.repoDir,
          baseRef: branch,
          branch: wiring.record.branch,
          image: config.image,
          env: {
            ...environment(config, { purpose: "worker", subtask: subtask.id, slot }),
            [CREDENTIAL_VARIABLES[workers.agent]]: credential,
          },
          logDir: runDir,
        }),
      ),
    )
    .catch((error: unknown) => {
    failures.push(error);
    return null;
  });
  if (worker === null) return { result: null, failures };
  let result: LoopResult | null = null;
  try {
    const { limits } = config;
    result = await attemptSubtask({
      clock: ports.clock,
      agent: workers,
      prompt: await workerPrompt(issue, subtask, config, wiring.followUp),
      record: wiring.record,
      limits: { ...stopLimits(config, workers), attemptIdleTimeoutMs: limits.attemptIdleTimeoutMs },
      runStartedAt: wiring.startedAt,
      runTokens: wiring.runTokens,
      attempt: (prompt, attemptLimits) =>
        inStage("attempt", () => worker.attempt({ kind: workers.agent, model: workers.model }, prompt, attemptLimits)),
      gate: wiring.gate,
      extendScope: wiring.extendScope,
      save: wiring.save,
      paused: wiring.paused,
    });
  } catch (error) {
    failures.push(error);
  }
  await gitLock.exclusive(() => inStage("close", () => worker.close())).catch((error: unknown) => {
    failures.push(error);
  });
  return { result, failures };
}

function environment(config: ResolvedConfig, context: WorkerEnvironmentContext): Record<string, string> {
  const env: unknown = config.environment(context);
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new Error(`the environment of .factory/config.ts must return an object for the ${context.purpose}`);
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") throw new Error(`the environment of .factory/config.ts gives ${key} a non-string value`);
  }
  return env as Record<string, string>;
}

function stopLimits(config: ResolvedConfig, workers: RoleChoice): StopLimits {
  const { agents, limits } = config;
  return {
    patience: limits.patience,
    subtaskWallClockMs: limits.subtaskWallClockMs,
    runWallClockMs: limits.runWallClockMs,
    subtaskTokens: agents[workers.agent].tokensPerSubtask,
    runTokens: agents[workers.agent].tokensPerRun,
  };
}

async function workerPrompt(issue: Issue, subtask: Subtask, config: ResolvedConfig, followUp?: string): Promise<string> {
  const texts = criteriaText(issue.body);
  const list = (items: string[]) => (items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- (none)");
  const base = renderTemplate(await readPromptTemplate("worker"), {
    subtask: subtask.id,
    issue: String(issue.number),
    title: issue.title,
    criteria: list(subtask.criteria.map((id) => texts[id] ?? id)),
    scope: list(subtask.scope),
    protectedPaths: list(config.protectedPaths),
    checks: list(config.checks.map((check) => `${check.name}: \`${check.command}\``)),
  });
  if (followUp === undefined) return base;
  const section = renderTemplate(await readPromptTemplate("follow-up"), { subtask: subtask.id, failure: followUp });
  return `${base}\n\n${section}`;
}

function workerId(issue: number, label: string, record: SubtaskRecord): string {
  return record.carriedLoop === undefined ? `${issue}-${label}` : `${issue}-${label}-from-${record.attempts.length + 1}`;
}

export function subtaskBranch(integration: string, subtaskId: string): string {
  return `factory-subtask/${integration.replace(/^factory\//, "")}/${subtaskId}`;
}

export function mergeMessage(issue: number, subtaskId: string): string {
  return `Merge subtask ${subtaskId} of #${issue}\n\n${SUBTASK_TRAILER}: ${subtaskId}`;
}

function notificationMessage(log: RunLog, title: string): string {
  if (log.result === "ready") return `Ready for review: ${title}`;
  if (log.result !== "paused") return `Draft: ${title}`;
  return log.resetsAt === undefined ? `Paused: ${title}` : `Paused until the plan limit resets at ${log.resetsAt}: ${title}`;
}

function blockTypeOf(stop: StopType): BlockType {
  return stop === "patience" ? "patience" : "limit";
}
