import { join } from "node:path";
import type { ResolvedConfig, RoleChoice, WorkerEnvironmentContext } from "../config/config.ts";
import { loadConfig } from "../config/load.ts";
import {
  createBranchAt,
  deleteBranch,
  integrationBranch,
  mergeBranch,
  pushBranch,
  showFile,
  withBranchWorktree,
} from "../git/repo.ts";
import type { Issue, PullRequest } from "../github/github.ts";
import { readPromptTemplate, renderTemplate } from "../prompts/template.ts";
import { criteriaText, issueCriteria } from "../spec/issue.ts";
import { parseSpec, validateSpec, type Subtask } from "../spec/spec.ts";
import { emptyUsage } from "../workers/agent-adapter.ts";
import { missingRequirements } from "../workers/agents.ts";
import { inStage, WorkerLayerError } from "../workers/failures.ts";
import { revParse } from "../workers/git.ts";
import type { AgentKind, AttemptResult } from "../workers/types.ts";
import { approvalProblem, gateDecision, runId as makeRunId, runResult } from "./decisions.ts";
import type { RunPorts } from "./ports.ts";
import { renderPullRequest } from "./pull-request.ts";
import {
  RUN_LOG_VERSION,
  writeRunLog,
  type AttemptRecord,
  type BlockType,
  type CheckRecord,
  type RunLog,
  type SubtaskRecord,
} from "./run-log.ts";
import { applyTotals, emptyCost, emptyFriction } from "./run-totals.ts";

export const CREDENTIAL_VARIABLES: Record<AgentKind, string> = {
  "claude-code": "CLAUDE_CODE_OAUTH_TOKEN",
  opencode: "OPENCODE_API_KEY",
};

export const REMOTE = "origin";
export const PULL_REQUEST_BASE = "main";

export interface RunRequest {
  repoDir: string;
  issue: number;
  credentials: Partial<Record<AgentKind, string>>;
  workers?: RoleChoice;
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
  subtask: Subtask;
  humanCriteria: string[];
  workers: RoleChoice;
  credential: string;
}

export async function runIssue(request: RunRequest, ports: RunPorts): Promise<RunReport> {
  const prepared = await prepare(request, ports);
  const { config, issue, branch, subtask, workers, humanCriteria } = prepared;
  const startedAt = ports.clock.now();
  const id = makeRunId(request.issue, startedAt);
  const runDir = join(request.repoDir, ".factory", "logs", id);
  const runLogPath = join(runDir, "run.json");
  const record: SubtaskRecord = {
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
  };
  const log: RunLog = {
    version: RUN_LOG_VERSION,
    runId: id,
    issue: request.issue,
    integrationBranch: branch,
    startedAt: startedAt.toISOString(),
    result: "running",
    agents: { workers, verifier: config.roles.verifier, changes: [] },
    criteria: { passing: [], blocked: [], human: humanCriteria, pending: [] },
    cost: emptyCost(),
    friction: emptyFriction(),
    workerLayerFailures: [],
    subtasks: [record],
  };
  const save = () => {
    applyTotals(log, ports.clock.now());
    return writeRunLog(runLogPath, log);
  };
  await save();

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

  const checksOn = async (label: string, sha: string, context: WorkerEnvironmentContext, subtaskId: string | null) => {
    const checkBranch = `factory-check/${id}/${label}`;
    const env = environment(config, context);
    await createBranchAt(request.repoDir, checkBranch, sha);
    const started = await inStage("start", () =>
      ports.runner.start({ id: `${id}-${label}`, repoDir: request.repoDir, baseRef: checkBranch, branch: checkBranch, image: config.image, env, logDir: runDir }),
    ).then(
      (worker) => ({ worker }),
      async (error: unknown) => {
        await deleteBranch(request.repoDir, checkBranch).catch(() => undefined);
        await noteFailure(error, subtaskId);
        return { worker: null };
      },
    );
    if (started.worker === null) return null;
    const { worker } = started;
    let checks: CheckRecord[] | null = [];
    let preserved = false;
    try {
      for (const check of config.checks) {
        const result = await inStage("exec", () => worker.exec(check.command));
        checks.push({ name: check.name, command: check.command, exitCode: result.exitCode, passed: result.exitCode === 0 });
      }
    } catch (error) {
      checks = null;
      await noteFailure(error, subtaskId);
    } finally {
      try {
        preserved = (await inStage("close", () => worker.close())).preservedWorktreePath !== undefined;
      } catch (error) {
        await noteFailure(error, subtaskId);
      }
    }
    if (!preserved) await deleteBranch(request.repoDir, checkBranch);
    return checks;
  };

  record.state = "working";
  await save();
  const worked = await runWorker(request, ports, prepared, record, runDir, startedAt);
  const unclassified = worked.failures.find((failure) => !(failure instanceof WorkerLayerError));
  if (unclassified !== undefined) throw unclassified;
  for (const failure of worked.failures) await noteFailure(failure, record.id);
  const attempt = worked.result;
  if (attempt !== null) record.attempts.push(attemptRecord(1, attempt, workers));
  if (attempt === null) {
    record.state = "interrupted";
    record.reason = "A failure of the worker layer stopped it before its attempt ended.";
  } else record.state = attempt.outcome.kind === "completed" ? "gating" : "pending";
  await save();

  if (attempt?.outcome.kind === "completed") {
    const sha = await revParse(request.repoDir, record.branch);
    const checks = await checksOn(`${subtask.id}-gate`, sha, { purpose: "gate", subtask: subtask.id, slot: 0 }, record.id);
    if (checks === null) {
      record.state = "interrupted";
      record.reason = "A failure of the worker layer stopped its gate.";
    } else {
      const decision = gateDecision(checks);
      record.gate = { sha, ...decision, checks };
      if (!decision.accepted) {
        record.gateRejections += 1;
        record.state = "blocked";
        record.reason = `The gate rejected it: ${decision.reasons.join("; ")}.`;
      } else {
        const merged = await withBranchWorktree(request.repoDir, branch, (worktree) =>
          mergeBranch(worktree, record.branch, mergeMessage(request.issue, subtask.id)),
        );
        if (merged.kind === "merged") record.state = "merged";
        else {
          record.conflicts += 1;
          record.state = "blocked";
          record.reason = `Its merge into ${branch} conflicts in ${merged.files.join(", ")}.`;
        }
      }
    }
  } else if (attempt?.outcome.kind === "plan-limit") {
    log.pauseReason = `the plan limit of ${workers.agent} was reached: ${attempt.outcome.message}`;
  } else if (attempt !== null) {
    record.state = "blocked";
    const blockType = blockTypeOf(attempt.outcome);
    if (blockType !== undefined) record.blockType = blockType;
    record.reason = `Its attempt ended with ${attempt.outcome.kind}${outcomeDetail(attempt) ? `: ${outcomeDetail(attempt)}` : ""}.`;
  }
  await save();

  if (log.pauseReason === undefined) {
    const sha = await revParse(request.repoDir, branch);
    const checks = await checksOn("verification", sha, { purpose: "verification", subtask: null, slot: 0 }, null);
    if (checks !== null) log.verification = { sha, passed: checks.every((check) => check.passed), checks };
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
    message: `${log.result === "ready" ? "Ready for review" : log.result === "paused" ? "Paused" : "Draft"}: ${issue.title}`,
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
  const [subtask, ...others] = parsed.spec.subtasks;
  const humanCriteria = Object.entries(parsed.spec.criteria)
    .filter(([, evidence]) => evidence.evidence === "human")
    .map(([id]) => id);
  if (parsed.spec.base !== null || subtask === undefined || others.length > 0) {
    throw new Error(`factory run supports only a spec with one subtask and no base subtask for now`);
  }

  const workers = request.workers ?? config.roles.workers;
  const missing = missingRequirements(workers.agent, "workers");
  if (missing.length > 0) throw new Error(`${workers.agent} cannot serve the workers: it misses ${missing.join(", ")}`);
  const credential = request.credentials[workers.agent];
  if (!credential) {
    throw new Error(`${CREDENTIAL_VARIABLES[workers.agent]} is not set; the ${workers.agent} workers need it`);
  }
  return { config, issue, branch, subtask, humanCriteria, workers, credential };
}

interface Worked {
  result: AttemptResult | null;
  failures: unknown[];
}

async function runWorker(
  request: RunRequest,
  ports: RunPorts,
  prepared: Prepared,
  record: SubtaskRecord,
  runDir: string,
  startedAt: Date,
): Promise<Worked> {
  const { config, issue, branch, subtask, workers, credential } = prepared;
  const failures: unknown[] = [];
  const worker = await inStage("start", () =>
    ports.runner.start({
      id: `${request.issue}-${subtask.id}`,
      repoDir: request.repoDir,
      baseRef: branch,
      branch: record.branch,
      image: config.image,
      env: {
        ...environment(config, { purpose: "worker", subtask: subtask.id, slot: 0 }),
        [CREDENTIAL_VARIABLES[workers.agent]]: credential,
      },
      logDir: runDir,
    }),
  ).catch((error: unknown) => {
    failures.push(error);
    return null;
  });
  if (worker === null) return { result: null, failures };
  let result: AttemptResult | null = null;
  try {
    const prompt = await workerPrompt(issue, subtask, config);
    result = await inStage("attempt", () =>
      worker.attempt({ kind: workers.agent, model: workers.model }, prompt, {
        deadline: new Date(startedAt.getTime() + config.limits.subtaskWallClockMs),
        idleTimeoutMs: config.limits.attemptIdleTimeoutMs,
      }),
    );
  } catch (error) {
    failures.push(error);
  }
  await inStage("close", () => worker.close()).catch((error: unknown) => {
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

async function workerPrompt(issue: Issue, subtask: Subtask, config: ResolvedConfig): Promise<string> {
  const texts = criteriaText(issue.body);
  const list = (items: string[]) => (items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- (none)");
  return renderTemplate(await readPromptTemplate("worker"), {
    subtask: subtask.id,
    issue: String(issue.number),
    title: issue.title,
    criteria: list(subtask.criteria.map((id) => texts[id] ?? id)),
    scope: list(subtask.scope),
    protectedPaths: list(config.protectedPaths),
    checks: list(config.checks.map((check) => `${check.name}: \`${check.command}\``)),
  });
}

export function subtaskBranch(integration: string, subtaskId: string): string {
  return `factory-subtask/${integration.replace(/^factory\//, "")}/${subtaskId}`;
}

export function mergeMessage(issue: number, subtaskId: string): string {
  return `Merge subtask ${subtaskId} of #${issue}\n\nFactory-Subtask: ${subtaskId}`;
}

function outcomeDetail(result: AttemptResult): string | undefined {
  const outcome = result.outcome;
  if (outcome.kind === "agent-error" || outcome.kind === "plan-limit") return outcome.message;
  if (outcome.kind === "completed") return outcome.summary;
  return undefined;
}

function blockTypeOf(outcome: AttemptResult["outcome"]): BlockType | undefined {
  if (outcome.kind === "deadline" || outcome.kind === "idle-timeout") return "limit";
  if (outcome.kind === "agent-error") return "environment";
  return undefined;
}

function attemptRecord(number: number, result: AttemptResult, agent: RoleChoice): AttemptRecord {
  const detail = outcomeDetail(result);
  return {
    number,
    agent,
    outcome: result.outcome.kind,
    ...(detail !== undefined ? { detail } : {}),
    usage: result.usage,
    logPath: result.logPath,
    startedAt: result.startedAt.toISOString(),
    endedAt: result.endedAt.toISOString(),
  };
}
