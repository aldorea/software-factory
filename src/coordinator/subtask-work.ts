import type { ResolvedConfig } from "../config/config.ts";
import { CREDENTIAL_VARIABLES } from "../config/credentials.ts";
import { mergeBranch, moveBranch, withBranchWorktree } from "../git/repo.ts";
import type { Issue } from "../github/github.ts";
import { readPromptTemplate, renderTemplate } from "../prompts/template.ts";
import { criteriaText } from "../spec/issue.ts";
import type { Subtask } from "../spec/spec.ts";
import { inStage, WorkerLayerError } from "../workers/failures.ts";
import { emptyUsage } from "../workers/agent-adapter.ts";
import { revParse } from "../workers/git.ts";
import { checksOn } from "./check-container.ts";
import { verifiedDecision } from "./decisions.ts";
import { changedPaths } from "./diff.ts";
import { gatePlan } from "./evidence.ts";
import { gateDecision, protectedFor, type GateDecision } from "./gate.ts";
import { environment, paused, stopLimits, type RunContext } from "./run-context.ts";
import { SUBTASK_TRAILER } from "./run-history.ts";
import type { CarriedLoopRecord, SubtaskRecord } from "./run-log.ts";
import { addUsage, agentRunTokens } from "./run-totals.ts";
import { decideScopeExtension, type ScopeExtensionDecision } from "./scope-extension.ts";
import { attemptSubtask, type EnvironmentHit, type LoopResult, type PlanLimitHit } from "./subtask-loop.ts";
import {
  applyMerge,
  applySettlement,
  entryOf,
  notStartedReason,
  settleLoop,
  waveScopes,
  type FollowUpOutcome,
} from "./subtask-settlement.ts";
import { judgeTests, NO_JUDGMENT } from "./test-judgment.ts";

export interface FollowUpRound {
  round: number;
  criteria: string[];
  text: string;
}

export async function startSubtask(context: RunContext, subtask: Subtask, slot: number): Promise<void> {
  const record = entryOf(context.records, subtask.id, "record");
  if (paused(context) || record.state === "merged" || record.state === "blocked") return;
  const reason = notStartedReason({
    subtask,
    baseId: context.prepared.plan.base?.id ?? null,
    states: new Map([...context.records].map(([id, entry]) => [id, entry.state])),
    conflicted: context.conflicted,
  });
  if (reason !== null) {
    record.state = "not-started";
    record.reason = reason;
    await context.save();
    return;
  }
  await workOn(context, subtask, slot, null);
}

export async function workOn(
  context: RunContext,
  subtask: Subtask,
  slot: number,
  followUp: FollowUpRound | null,
): Promise<FollowUpOutcome> {
  const { repoDir, issue } = context.request;
  const { branch } = context.prepared;
  const record = entryOf(context.records, subtask.id, "record");
  const label = followUp ? `${subtask.id}-followup-${followUp.round}` : subtask.id;
  if (followUp) {
    await context.gitLock.exclusive(async () => moveBranch(repoDir, record.branch, await revParse(repoDir, branch)));
  }
  record.state = "working";
  await context.save();
  const worked = await workInWorker(context, {
    subtask: { ...subtask, scope: [...entryOf(context.scopes, subtask.id, "scope")] },
    record,
    slot,
    workerId: workerId(issue, label, record),
    carried: followUp ? context.budgets.get(subtask.id) : undefined,
    gate: (attempt) => gate(context, { subtask, record, slot, label, attempt, followUp: followUp !== null }),
    ...(followUp ? { followUp: followUp.text } : {}),
  });
  const unclassified = worked.failures.find((failure) => !(failure instanceof WorkerLayerError));
  if (unclassified !== undefined) throw unclassified;
  for (const failure of worked.failures) await context.noteFailure(failure, record.id);

  if (worked.result?.kind === "accepted") context.budgets.set(subtask.id, worked.result.budget);
  const settlement = settleLoop(worked.result);
  let outcome: FollowUpOutcome;
  if (settlement.kind === "merge") {
    const merged = await context.gitLock.exclusive(() =>
      withBranchWorktree(repoDir, branch, (worktree) => mergeBranch(worktree, record.branch, mergeMessage(issue, subtask.id))),
    );
    outcome = applyMerge(record, merged, branch);
    if (merged.kind === "conflict") context.conflicted = true;
  } else {
    outcome = applySettlement(record, settlement, followUp !== null);
    if (settlement.kind === "paused" && settlement.limit !== undefined) pauseRun(context, settlement.limit);
  }
  if (followUp) {
    record.followUps = [
      ...(record.followUps ?? []),
      { round: followUp.round, criteria: followUp.criteria, failure: followUp.text, outcome },
    ];
  }
  await context.save();
  return outcome;
}

export function pauseRun(context: RunContext, limit: PlanLimitHit): void {
  const { log, ports } = context;
  if (log.pauseReason !== undefined) return;
  log.pauseReason = `the plan limit of ${limit.agent} was reached: ${limit.message}`;
  log.pauses = [...(log.pauses ?? []), { agent: limit.agent, at: ports.clock.now().toISOString() }];
  if (limit.resetsAt !== undefined) log.resetsAt = limit.resetsAt.toISOString();
}

interface GateRequest {
  subtask: Subtask;
  record: SubtaskRecord;
  slot: number;
  label: string;
  attempt: number;
  followUp: boolean;
}

async function gate(context: RunContext, request: GateRequest): Promise<GateDecision | PlanLimitHit | EnvironmentHit | null> {
  const { repoDir } = context.request;
  const { branch, spec, config, issue, plan, verifier } = context.prepared;
  const { subtask, record, label, attempt } = request;
  const sha = await revParse(repoDir, record.branch);
  const gated = await checksOn(context, {
    label: `${label}-gate-${attempt}`,
    sha,
    purpose: { purpose: "gate", subtask: subtask.id, slot: request.slot },
    plan: gatePlan(spec, subtask.criteria, config.evidence),
    subtaskId: record.id,
  });
  if (gated === null) return null;
  if (gated.appProblem !== undefined) {
    record.gate = { sha, accepted: false, reasons: [gated.appProblem], checks: gated.checks, criteria: [], verifier: [] };
    return { kind: "environment", reason: `The app of the config failed at the gate: ${gated.appProblem}.` };
  }
  const { checks, criteria } = gated;
  const checked = gateDecision({
    changes: await changedPaths(repoDir, branch, sha),
    scope: entryOf(context.scopes, subtask.id, "scope"),
    protectedPaths: config.protectedPaths,
    isBase: subtask.id === plan.base?.id,
    existingTestPaths: context.existingTestPaths,
    authorizedTestChanges: subtask.testChanges,
    requestCheckPaths: context.requestChecks,
    checks,
    criteria,
  });
  const judgment = checked.accepted
    ? await judgeTests(context.ports.verifier, {
        repoDir,
        integrationBranch: request.followUp ? context.runStartSha : branch,
        sha,
        criteria,
        texts: criteriaText(issue.body),
        logDir: context.runDir,
        label: `${label}-attempt-${attempt}`,
        onActivity: (criterion, event) =>
          context.ports.activity?.({ source: `verifier ${criterion}`, at: context.ports.clock.now(), event }),
      })
    : NO_JUDGMENT;
  if (judgment.usage !== undefined) {
    record.verifierUsage = {
      ...record.verifierUsage,
      [verifier.agent]: addUsage(record.verifierUsage?.[verifier.agent] ?? emptyUsage(), judgment.usage),
    };
  }
  for (const problem of judgment.usageProblems) {
    await context.noteFailure(new WorkerLayerError("usage-unreadable", "attempt", problem), record.id);
  }
  if (judgment.planLimit !== undefined) {
    return { kind: "plan-limit", agent: verifier.agent, ...judgment.planLimit };
  }
  const decision = verifiedDecision(checked, judgment);
  const reasons = decision.rejections.filter((rejection) => rejection.kind !== "verifier").map((rejection) => rejection.message);
  record.gate = { sha, accepted: decision.accepted, reasons, checks, criteria, verifier: judgment.records };
  return decision;
}

function extendScope(context: RunContext, subtask: Subtask, requested: string[]): ScopeExtensionDecision {
  const { plan, config } = context.prepared;
  const scope = entryOf(context.scopes, subtask.id, "scope");
  const isBase = subtask.id === plan.base?.id;
  const decision = decideScopeExtension({
    requested,
    scope,
    waveScopes: waveScopes(plan, subtask.id, context.scopes),
    protectedPaths: protectedFor(isBase, config.protectedPaths),
    existingTestPaths: context.existingTestPaths,
    authorizedTestChanges: subtask.testChanges,
    requestCheckPaths: isBase ? [] : context.requestChecks,
  });
  if (decision.kind === "extend") {
    scope.push(...decision.paths);
    entryOf(context.records, subtask.id, "record").scopeExtensions.push(...decision.paths);
  }
  return decision;
}

interface Worked {
  result: LoopResult | null;
  failures: unknown[];
}

interface WorkerRequest {
  subtask: Subtask;
  record: SubtaskRecord;
  slot: number;
  workerId: string;
  carried: CarriedLoopRecord | undefined;
  followUp?: string;
  gate: (attempt: number) => Promise<GateDecision | PlanLimitHit | EnvironmentHit | null>;
}

async function workInWorker(context: RunContext, request: WorkerRequest): Promise<Worked> {
  const { repoDir } = context.request;
  const { config, issue, branch, workers, credential } = context.prepared;
  const { subtask, record } = request;
  const failures: unknown[] = [];
  const worker = await context.gitLock
    .exclusive(() =>
      inStage("start", () =>
        context.ports.runner.start({
          id: request.workerId,
          repoDir,
          baseRef: branch,
          branch: record.branch,
          image: config.image,
          env: {
            ...environment(config, { purpose: "worker", subtask: subtask.id, slot: request.slot }),
            [CREDENTIAL_VARIABLES[workers.agent]]: credential,
          },
          logDir: context.runDir,
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
    result = await attemptSubtask({
      clock: context.ports.clock,
      agent: workers,
      prompt: await workerPrompt(issue, subtask, config, request.followUp),
      record,
      ...(request.carried !== undefined ? { carried: request.carried } : {}),
      limits: { ...stopLimits(config, workers), attemptIdleTimeoutMs: config.limits.attemptIdleTimeoutMs },
      runStartedAt: context.startedAt,
      runTokens: () => agentRunTokens(context.log, workers.agent),
      attempt: (prompt, attemptLimits, hooks) =>
        inStage("attempt", () =>
          worker.attempt({ kind: workers.agent, model: workers.model }, prompt, attemptLimits, {
            ...hooks,
            onActivity: (event) => context.ports.activity?.({ source: subtask.id, at: context.ports.clock.now(), event }),
          }),
        ),
      gate: request.gate,
      extendScope: (requested) => extendScope(context, subtask, requested),
      save: () => context.save(),
      paused: () => paused(context),
    });
  } catch (error) {
    failures.push(error);
  }
  await context.gitLock.exclusive(() => inStage("close", () => worker.close())).catch((error: unknown) => {
    failures.push(error);
  });
  return { result, failures };
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

export function mergeMessage(issue: number, subtaskId: string): string {
  return `Merge subtask ${subtaskId} of #${issue}\n\n${SUBTASK_TRAILER}: ${subtaskId}`;
}
