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
import { missingRequirements } from "../workers/agents.ts";
import { revParse } from "../workers/git.ts";
import type { AgentKind, AttemptResult } from "../workers/types.ts";
import { approvalProblem, gateDecision, runId as makeRunId, runResult } from "./decisions.ts";
import type { RunPorts } from "./ports.ts";
import { renderPullRequest } from "./pull-request.ts";
import {
  RUN_LOG_VERSION,
  writeRunLog,
  type AttemptRecord,
  type CheckRecord,
  type RunLog,
  type SubtaskRecord,
} from "./run-log.ts";

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
  workers: RoleChoice;
  credential: string;
}

export async function runIssue(request: RunRequest, ports: RunPorts): Promise<RunReport> {
  const prepared = await prepare(request, ports);
  const { config, issue, branch, subtask, workers } = prepared;
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
  };
  const log: RunLog = {
    version: RUN_LOG_VERSION,
    runId: id,
    issue: request.issue,
    integrationBranch: branch,
    startedAt: startedAt.toISOString(),
    result: "running",
    agents: { workers },
    subtasks: [record],
  };
  const save = () => writeRunLog(runLogPath, log);
  await save();

  const checksOn = async (label: string, sha: string, context: WorkerEnvironmentContext) => {
    const checkBranch = `factory-check/${id}/${label}`;
    const env = environment(config, context);
    await createBranchAt(request.repoDir, checkBranch, sha);
    const worker = await ports.runner
      .start({ id: `${id}-${label}`, repoDir: request.repoDir, baseRef: checkBranch, branch: checkBranch, image: config.image, env, logDir: runDir })
      .catch(async (error: unknown) => {
        await deleteBranch(request.repoDir, checkBranch).catch(() => undefined);
        throw error;
      });
    const checks: CheckRecord[] = [];
    let preserved = false;
    try {
      for (const check of config.checks) {
        const result = await worker.exec(check.command);
        checks.push({ name: check.name, command: check.command, exitCode: result.exitCode, passed: result.exitCode === 0 });
      }
    } finally {
      preserved = (await worker.close()).preservedWorktreePath !== undefined;
    }
    if (!preserved) await deleteBranch(request.repoDir, checkBranch);
    return checks;
  };

  const attempt = await runWorker(request, ports, prepared, record, runDir, startedAt);
  record.attempts.push(attemptRecord(1, attempt));
  await save();

  if (attempt.outcome.kind === "completed") {
    const sha = await revParse(request.repoDir, record.branch);
    const checks = await checksOn(`${subtask.id}-gate`, sha, { purpose: "gate", subtask: subtask.id, slot: 0 });
    const decision = gateDecision(checks);
    record.gate = { sha, ...decision, checks };
    if (!decision.accepted) {
      record.state = "blocked";
      record.reason = `The gate rejected it: ${decision.reasons.join("; ")}.`;
    } else {
      const merged = await withBranchWorktree(request.repoDir, branch, (worktree) =>
        mergeBranch(worktree, record.branch, mergeMessage(request.issue, subtask.id)),
      );
      if (merged.kind === "merged") record.state = "merged";
      else {
        record.state = "blocked";
        record.reason = `Its merge into ${branch} conflicts in ${merged.files.join(", ")}.`;
      }
    }
  } else if (attempt.outcome.kind === "plan-limit") {
    log.pauseReason = `the plan limit of ${workers.agent} was reached: ${attempt.outcome.message}`;
  } else {
    record.state = "blocked";
    record.reason = `Its attempt ended with ${attempt.outcome.kind}${outcomeDetail(attempt) ? `: ${outcomeDetail(attempt)}` : ""}.`;
  }
  await save();

  if (log.pauseReason === undefined) {
    const sha = await revParse(request.repoDir, branch);
    const checks = await checksOn("verification", sha, { purpose: "verification", subtask: null, slot: 0 });
    log.verification = { sha, passed: checks.every((check) => check.passed), checks };
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
  return { config, issue, branch, subtask, workers, credential };
}

async function runWorker(
  request: RunRequest,
  ports: RunPorts,
  prepared: Prepared,
  record: SubtaskRecord,
  runDir: string,
  startedAt: Date,
): Promise<AttemptResult> {
  const { config, issue, branch, subtask, workers, credential } = prepared;
  const worker = await ports.runner.start({
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
  });
  try {
    const prompt = await workerPrompt(issue, subtask, config);
    return await worker.attempt({ kind: workers.agent, model: workers.model }, prompt, {
      deadline: new Date(startedAt.getTime() + config.limits.subtaskWallClockMs),
      idleTimeoutMs: config.limits.attemptIdleTimeoutMs,
    });
  } finally {
    await worker.close();
  }
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

function attemptRecord(number: number, result: AttemptResult): AttemptRecord {
  const detail = outcomeDetail(result);
  return {
    number,
    outcome: result.outcome.kind,
    ...(detail !== undefined ? { detail } : {}),
    usage: result.usage,
    logPath: result.logPath,
    startedAt: result.startedAt.toISOString(),
    endedAt: result.endedAt.toISOString(),
  };
}
