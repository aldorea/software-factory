import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { AppStart, RoleChoice } from "../config/config.ts";
import { CREDENTIAL_VARIABLES } from "../config/credentials.ts";
import { readPromptTemplate, renderTemplate } from "../prompts/template.ts";
import { criteriaText } from "../spec/issue.ts";
import { emptyUsage } from "../workers/agent-adapter.ts";
import { inStage } from "../workers/failures.ts";
import type { ActivityEvent, AttemptOutcome, AttemptResult } from "../workers/types.ts";
import { inCheckContainer } from "./check-container.ts";
import { TESTER_EVIDENCE } from "./evidence-branch.ts";
import { filesIn, startApp } from "./evidence-collection.ts";
import { outputTail } from "./failures.ts";
import { followUpStop } from "./follow-up.ts";
import { environment, stopLimits, type RunContext } from "./run-context.ts";
import type { CriterionRecord, TesterRecord } from "./run-log.ts";
import { addUsage, agentRunTokens } from "./run-totals.ts";
import { formatDuration } from "./stop-rules.ts";
import type { PlanLimitHit } from "./subtask-loop.ts";
import { evidenceProblem, parseTesterReport } from "./tester-report.ts";

export const TESTER_TIMEOUT_MS = 30 * 60 * 1000;

export interface TesterRequest {
  label: string;
  sha: string;
  criteria: CriterionRecord[];
}

export type TesterOutcome = { kind: "tested"; record: TesterRecord } | PlanLimitHit;

type Attempted = { kind: "app-problem"; problem: string } | { kind: "attempted"; result: AttemptResult };

export async function acceptanceTest(context: RunContext, request: TesterRequest): Promise<TesterOutcome> {
  const { config, tester } = context.prepared;
  const { log } = context;
  const now = context.ports.clock.now();
  const stop = followUpStop(
    { signatures: [], runElapsedMs: now.getTime() - context.startedAt.getTime(), runTokens: agentRunTokens(log, tester.agent) },
    stopLimits(config, tester),
  );
  if (stop !== null) return tested(tester, { error: `The acceptance tester did not start: ${stop.reason}` });

  const label = `${request.label}-tester`;
  const evidenceDir = join(context.request.repoDir, ".factory", "worktrees", `evidence-${log.runId}-${label}`);
  await rm(evidenceDir, { recursive: true, force: true });
  await mkdir(evidenceDir, { recursive: true });
  try {
    const prompt = await testerPrompt(context, request.criteria, evidenceDir);
    const attempted = await inCheckContainer<Attempted>(
      context,
      {
        label,
        sha: request.sha,
        env: {
          ...environment(config, { purpose: "tester", subtask: null, slot: 0 }),
          [CREDENTIAL_VARIABLES[tester.agent]]: context.request.credentials[tester.agent] ?? "",
        },
        subtaskId: null,
        outputDir: evidenceDir,
      },
      async (worker) => {
        const appProblem = config.app ? await startApp(worker, config.app) : null;
        if (appProblem !== null) return { kind: "app-problem", problem: appProblem };
        const deadline = new Date(context.ports.clock.now().getTime() + TESTER_TIMEOUT_MS);
        const limits = { deadline, idleTimeoutMs: config.limits.attemptIdleTimeoutMs };
        const hooks = { onActivity: (event: ActivityEvent) => context.ports.activity?.({ source: "tester", at: context.ports.clock.now(), event }) };
        const agent = { kind: tester.agent, model: tester.model };
        return { kind: "attempted", result: await inStage("attempt", () => worker.attempt(agent, prompt, limits, hooks)) };
      },
    );
    if (attempted === null) return tested(tester, { error: "A failure of the worker layer stopped the acceptance tester." });
    if (attempted.kind === "app-problem") return tested(tester, { error: `The app did not start for the acceptance tester: ${attempted.problem}` });

    const { result } = attempted;
    const kept = join(TESTER_EVIDENCE, request.label);
    const files = await keepEvidence(evidenceDir, join(context.runDir, kept));
    log.testerUsage = { ...log.testerUsage, [tester.agent]: addUsage(log.testerUsage?.[tester.agent] ?? emptyUsage(), result.usage) };
    const logPath = relative(context.runDir, result.logPath);
    const { outcome } = result;
    if (outcome.kind === "plan-limit") {
      return { kind: "plan-limit", agent: tester.agent, message: outcome.message, ...(outcome.resetsAt ? { resetsAt: outcome.resetsAt } : {}) };
    }
    if (outcome.kind !== "completed") return tested(tester, { error: endedWithout(outcome), logPath });

    const parsed = parseTesterReport(outcome.summary, { ids: request.criteria.map((criterion) => criterion.id), evidenceDir });
    if (!parsed.ok) return tested(tester, { error: `The acceptance tester gave no usable report: ${parsed.problem}.`, logPath });
    const missing = evidenceProblem(parsed.verdicts, files);
    if (missing !== null) return tested(tester, { error: `The acceptance tester gave no usable report: ${missing}.`, logPath });

    const verdicts = parsed.verdicts.map((verdict) => ({ ...verdict, evidence: verdict.evidence.map((path) => join(kept, path)) }));
    log.testerFailures = [
      ...(log.testerFailures ?? []),
      ...verdicts
        .filter((verdict) => !verdict.passed)
        .map((verdict) => ({ sha: request.sha, criterion: verdict.id, observation: verdict.observation })),
    ];
    return tested(tester, { verdicts, logPath });
  } finally {
    await rm(evidenceDir, { recursive: true, force: true });
  }
}

async function keepEvidence(evidenceDir: string, target: string): Promise<Set<string>> {
  const kept = new Set<string>();
  for (const file of await filesIn(evidenceDir)) {
    const path = relative(evidenceDir, file);
    await mkdir(dirname(join(target, path)), { recursive: true });
    await copyFile(file, join(target, path));
    kept.add(path);
  }
  return kept;
}

function tested(agent: RoleChoice, record: Partial<TesterRecord>): TesterOutcome {
  return { kind: "tested", record: { agent, verdicts: [], ...record } };
}

function endedWithout(outcome: Exclude<AttemptOutcome, { kind: "completed" } | { kind: "plan-limit" }>): string {
  if (outcome.kind === "deadline") return `The acceptance tester reached its deadline of ${formatDuration(TESTER_TIMEOUT_MS)} before it reported.`;
  if (outcome.kind === "idle-timeout") return "The acceptance tester was stopped because it was idle for too long.";
  return `The acceptance tester failed${outcome.exitCode === null ? "" : ` with exit code ${outcome.exitCode}`}: ${outcome.message}`;
}

async function testerPrompt(context: RunContext, criteria: CriterionRecord[], evidenceDir: string): Promise<string> {
  const texts = criteriaText(context.prepared.issue.body);
  return renderTemplate(await readPromptTemplate("tester"), {
    app: appText(context.prepared.config.app),
    criteria: criteria
      .map((criterion) => `- ${criterion.id} (${criterion.evidence}): ${(texts[criterion.id] ?? "").replace(/^\**A[0-9]+\b\**\s*/, "")}`)
      .join("\n"),
    evidenceDir,
  });
}

function appText(app: AppStart | undefined): string {
  if (app === undefined) return "The config of the repository starts no app: reach the application as its README and scripts say, never through its tests.";
  const ready = app.ready === undefined ? "" : ` and \`${app.ready}\` answered`;
  return `The app runs in this container: it was started with \`${app.start}\`${ready}. The environment of this container, such as \`E2E_PORT\`, says where it listens.`;
}

export async function evidenceTails(runDir: string, record: TesterRecord): Promise<Record<string, string>> {
  const tails: Record<string, string> = {};
  for (const verdict of record.verdicts) {
    if (verdict.passed) continue;
    for (const path of verdict.evidence) {
      const content = await readFile(join(runDir, path)).catch(() => null);
      if (content === null || content.includes(0)) continue;
      const tail = outputTail(content.toString("utf8"));
      if (tail !== undefined) tails[path] = tail;
    }
  }
  return tails;
}
