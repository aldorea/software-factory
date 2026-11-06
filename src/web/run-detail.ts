import { attemptAbandoned, runStatus, type RunStatus } from "../coordinator/abandoned.ts";
import type { RunEntry } from "../coordinator/run-history.ts";
import type {
  AgentChangeRecord,
  AttemptRecord,
  CheckRecord,
  CriteriaRecord,
  CriterionRecord,
  EvidenceBranchRecord,
  FollowUpRecord,
  GateRecord,
  HumanCriterionRecord,
  PublicationFailureRecord,
  RunBlockRecord,
  RunLog,
  SubtaskRecord,
  SubtaskState,
  TesterRecord,
  TesterVerdictRecord,
  VerificationRecord,
  VerifierRecord,
} from "../coordinator/run-log.ts";
import { countedTokens } from "../coordinator/stop-rules.ts";
import type { LogUrl } from "./log-path.ts";
import { safeLink } from "./safe-link.ts";

export interface RoleAgent {
  role: "workers" | "verifier" | "tester";
  agent: string;
  model: string;
}

export interface CheckView {
  name: string;
  passed: boolean;
  firstError: string | null;
  outputUrl: string | null;
}

export interface CriterionView {
  id: string;
  passed: boolean;
  outputUrl: string | null;
}

export interface AttemptView {
  number: number;
  agent: string;
  model: string;
  outcome: AttemptRecord["outcome"] | "abandoned";
  succeeded: boolean | null;
  detail: string | null;
  failure: string | null;
  tokens: number;
  startedAt: string;
  endedAt: string | null;
  logUrl: string | null;
}

export interface VerifierView {
  id: string;
  verdict: VerifierRecord["verdict"];
  accepted: boolean;
  reason: string | null;
  logUrl: string | null;
}

export interface GateView {
  sha: string;
  accepted: boolean;
  reasons: string[];
  checks: CheckView[];
  criteria: CriterionView[];
  verifier: VerifierView[];
}

export interface SubtaskBlockView {
  type: string | null;
  reason: string | null;
  lastFailure: string | null;
}

export interface SubtaskView {
  id: string;
  state: SubtaskState;
  criteria: string[];
  branch: string;
  scopeExtensions: string[];
  block: SubtaskBlockView | null;
  attempts: AttemptView[];
  gateRejections: number;
  verifierRejections: number;
  gate: GateView | null;
  followUps: FollowUpRecord[];
}

export interface TesterView {
  agent: string;
  model: string;
  logUrl: string | null;
  error: string | null;
  checks: CheckView[];
  verdicts: TesterVerdictRecord[];
}

export interface VerificationView {
  sha: string;
  passed: boolean;
  environment: string | null;
  checks: CheckView[];
  criteria: CriterionView[];
  humanCriteria: HumanCriterionRecord[];
  tester: TesterView | null;
}

export interface RunBlockView {
  type: RunBlockRecord["type"];
  reason: string;
  sha: string;
  files: string[];
  checks: CheckView[];
}

export interface RunDetail {
  now: string;
  issue: number;
  runId: string;
  status: RunStatus;
  modifiedAt: string;
  inProgress: boolean;
  pullRequest: { number: number; url: string | null; draft: boolean } | null;
  evidenceBranch: { branch: string; url: string | null } | null;
  publicationFailure: (PublicationFailureRecord & { command: string }) | null;
  pause: { reason: string | null; resetsAt: string | null } | null;
  block: RunBlockView | null;
  agents: { roles: RoleAgent[]; changes: AgentChangeRecord[] };
  criteria: CriteriaRecord;
  subtasks: SubtaskView[];
  verification: VerificationView | null;
}

function checkView(check: CheckRecord, logUrl: LogUrl): CheckView {
  return { name: check.name, passed: check.passed, firstError: check.firstError ?? null, outputUrl: logUrl(check.outputLog) };
}

function criterionView(criterion: CriterionRecord, logUrl: LogUrl): CriterionView {
  return { id: criterion.id, passed: criterion.passed, outputUrl: logUrl(criterion.outputLog) };
}

function attemptView(attempt: AttemptRecord, abandoned: boolean, logUrl: LogUrl): AttemptView {
  return {
    number: attempt.number,
    agent: attempt.agent.agent,
    model: attempt.agent.model,
    outcome: abandoned ? "abandoned" : attempt.outcome,
    succeeded: attempt.outcome === "running" && !abandoned ? null : attempt.outcome === "completed",
    detail: attempt.detail ?? null,
    failure: attempt.failure?.description ?? null,
    tokens: countedTokens(attempt.usage),
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt ?? null,
    logUrl: logUrl(attempt.logPath),
  };
}

function gateView(gate: GateRecord, logUrl: LogUrl): GateView {
  return {
    sha: gate.sha,
    accepted: gate.accepted,
    reasons: gate.reasons,
    checks: gate.checks.map((check) => checkView(check, logUrl)),
    criteria: gate.criteria.map((criterion) => criterionView(criterion, logUrl)),
    verifier: gate.verifier.map((record) => ({ id: record.id, verdict: record.verdict, accepted: record.verdict === "accept", reason: record.reason ?? null, logUrl: logUrl(record.logPath) })),
  };
}

function subtaskBlock(subtask: SubtaskRecord): SubtaskBlockView | null {
  if (subtask.state !== "blocked") return null;
  return {
    type: subtask.blockType ?? subtask.block?.type ?? null,
    reason: subtask.reason ?? subtask.block?.reason ?? null,
    lastFailure: subtask.block?.lastFailure ?? null,
  };
}

function subtaskView(subtask: SubtaskRecord, entry: RunEntry, now: Date, logUrl: LogUrl): SubtaskView {
  return {
    id: subtask.id,
    state: subtask.state,
    criteria: subtask.criteria,
    branch: subtask.branch,
    scopeExtensions: subtask.scopeExtensions,
    block: subtaskBlock(subtask),
    attempts: subtask.attempts.map((attempt) => attemptView(attempt, attemptAbandoned(attempt, entry, now), logUrl)),
    gateRejections: subtask.gateRejections,
    verifierRejections: subtask.verifierRejections,
    gate: subtask.gate === undefined ? null : gateView(subtask.gate, logUrl),
    followUps: subtask.followUps ?? [],
  };
}

function testerView(tester: TesterRecord, logUrl: LogUrl): TesterView {
  return {
    agent: tester.agent.agent,
    model: tester.agent.model,
    logUrl: logUrl(tester.logPath),
    error: tester.error ?? null,
    checks: (tester.checks ?? []).map((check) => checkView(check, logUrl)),
    verdicts: tester.verdicts,
  };
}

function verificationView(verification: VerificationRecord, logUrl: LogUrl): VerificationView {
  return {
    sha: verification.sha,
    passed: verification.passed,
    environment: verification.environment ?? null,
    checks: verification.checks.map((check) => checkView(check, logUrl)),
    criteria: verification.criteria.map((criterion) => criterionView(criterion, logUrl)),
    humanCriteria: verification.humanCriteria,
    tester: verification.tester === undefined ? null : testerView(verification.tester, logUrl),
  };
}

function blockView(block: RunBlockRecord, logUrl: LogUrl): RunBlockView {
  const base = { type: block.type, reason: block.reason, sha: block.sha };
  if (block.type === "default-branch-conflict") return { ...base, files: block.files, checks: [] };
  return { ...base, files: [], checks: block.checks.map((check) => checkView(check, logUrl)) };
}

function evidenceBranchView(evidence: EvidenceBranchRecord): RunDetail["evidenceBranch"] {
  const repositoryUrl = evidence.repositoryUrl === undefined ? null : safeLink(evidence.repositoryUrl);
  const path = evidence.branch.split("/").map(encodeURIComponent).join("/");
  return { branch: evidence.branch, url: repositoryUrl === null ? null : `${repositoryUrl}/tree/${path}` };
}

function roles({ agents }: RunLog): RoleAgent[] {
  const choices = [
    ["workers", agents.workers],
    ["verifier", agents.verifier],
    ["tester", agents.tester],
  ] as const;
  return choices.flatMap(([role, choice]) => (choice === undefined ? [] : [{ role, agent: choice.agent, model: choice.model }]));
}

export function runDetail(entry: RunEntry, now: Date, logUrl: LogUrl): RunDetail {
  const { log } = entry;
  const status = runStatus(entry, now);
  const working = status === "running";
  return {
    now: now.toISOString(),
    issue: log.issue,
    runId: log.runId,
    status,
    modifiedAt: entry.modifiedAt.toISOString(),
    inProgress: working,
    pullRequest: log.pullRequest === undefined ? null : { number: log.pullRequest.number, url: safeLink(log.pullRequest.url), draft: log.pullRequest.draft },
    evidenceBranch: log.evidence === undefined ? null : evidenceBranchView(log.evidence),
    publicationFailure: working || log.publicationFailure === undefined ? null : { ...log.publicationFailure, command: `factory publish ${log.issue}` },
    pause: log.result === "paused" ? { reason: log.pauseReason ?? null, resetsAt: log.resetsAt ?? null } : null,
    block: working || log.block === undefined ? null : blockView(log.block, logUrl),
    agents: { roles: roles(log), changes: log.agents.changes },
    criteria: log.criteria,
    subtasks: log.subtasks.map((subtask) => subtaskView(subtask, entry, now, logUrl)),
    verification: log.verification === undefined ? null : verificationView(log.verification, logUrl),
  };
}
