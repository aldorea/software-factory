import { idleTimeoutOf, runAbandoned } from "../coordinator/abandoned.ts";
import type { RunEntry } from "../coordinator/run-history.ts";
import type { RoleChoice } from "../config/config.ts";
import type { AttemptRecord, RunLog, SubtaskRecord, TesterRecord, VerifierRecord } from "../coordinator/run-log.ts";
import { emptyUsage } from "../workers/agent-adapter.ts";
import { adapterFor } from "../workers/agents.ts";
import { claudeMessagesUsage } from "../workers/claude-code.ts";
import type { ActivityEvent, AgentKind, TokenUsage } from "../workers/types.ts";

export type AgentState = "working" | "silent" | "abandoned" | "ended";

export type LiveRole = "worker" | "independent-verifier" | "acceptance-tester";

export interface LiveEvent {
  at: string;
  kind: ActivityEvent["kind"];
  text: string;
}

export interface LiveAgent {
  id: string;
  runId: string;
  issue: number;
  role: LiveRole;
  agent: string;
  model: string;
  subtask: string | null;
  criterion: string | null;
  attempt: number;
  step: string;
  lastTool: string | null;
  lastMessage: string | null;
  events: LiveEvent[];
  startedAt: string;
  elapsedMs: number;
  silentMs: number;
  abandonAfterMs: number;
  abandonInMs: number | null;
  state: AgentState;
  outcome: string | null;
  succeeded: boolean | null;
  tokens: { input: number; output: number } | null;
}

export interface LiveRun {
  runId: string;
  issue: number;
  title: string;
  step: string;
  startedAt: string;
  agents: LiveAgent[];
}

export interface LiveResponse {
  now: string;
  inProgress: boolean;
  atWork: number;
  runs: LiveRun[];
}

export type RawLogTails = ReadonlyMap<string, readonly string[]>;

export const LIVE_EVENTS = 20;
export const SILENT_AFTER_MS = 60_000;

function timestampOf(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("timestamp" in parsed)) return null;
  const { timestamp } = parsed;
  const time = typeof timestamp === "number" ? timestamp : typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function eventText(event: ActivityEvent): string {
  if (event.kind === "message") return event.text;
  if (event.kind === "tool") return event.target === undefined ? event.tool : `${event.tool} ${event.target}`;
  return event.outcome === "completed" ? "intento terminado" : "intento fallido";
}

export function rawLogEvents(kind: AgentKind, lines: readonly string[], fallbackAt: Date): LiveEvent[] {
  const stream = adapterFor(kind).createStream();
  let at = fallbackAt.toISOString();
  const events: LiveEvent[] = [];
  for (const line of lines) {
    stream.onLine(line);
    at = timestampOf(line) ?? at;
    for (const event of stream.activity?.(line) ?? []) events.push({ at, kind: event.kind, text: eventText(event) });
  }
  return events.slice(-LIVE_EVENTS);
}

function lastOf(events: readonly LiveEvent[], kind: LiveEvent["kind"]): string | null {
  return events.findLast((event) => event.kind === kind)?.text ?? null;
}

function tokenCounts(usage: TokenUsage): { input: number; output: number } {
  return { input: usage.inputTokens + usage.cacheCreationInputTokens, output: usage.outputTokens };
}

function runningTokens(kind: AgentKind, lines: readonly string[]): LiveAgent["tokens"] {
  if (kind !== "claude-code") return null;
  const usage = claudeMessagesUsage(lines);
  return usage === null ? null : tokenCounts(usage);
}

interface AgentSource {
  id: string;
  role: LiveRole;
  choice: RoleChoice;
  subtask: string | null;
  criterion: string | null;
  attempt: number;
  step: string;
  logPath: string | undefined;
  startedAt: string;
  quietSince: Date;
  ended: { endedAt: string | undefined; outcome: string; succeeded: boolean; tokens: LiveAgent["tokens"] } | null;
}

function agentState(source: AgentSource, silentMs: number, log: RunLog): AgentState {
  if (source.ended !== null) return "ended";
  if (silentMs > idleTimeoutOf(log)) return "abandoned";
  return silentMs > SILENT_AFTER_MS ? "silent" : "working";
}

function liveAgent(entry: RunEntry, source: AgentSource, tails: RawLogTails, now: Date): LiveAgent {
  const { log } = entry;
  const running = source.ended === null;
  const startedAt = Date.parse(source.startedAt);
  const lastChange = (source.logPath === undefined ? undefined : entry.logTimes.get(source.logPath)) ?? source.quietSince;
  const silentMs = running ? Math.max(0, now.getTime() - lastChange.getTime()) : 0;
  const endedAt = source.ended?.endedAt === undefined ? now.getTime() : Date.parse(source.ended.endedAt);
  const tail = source.logPath === undefined ? [] : (tails.get(source.logPath) ?? []);
  const kind = source.choice.agent;
  const events = rawLogEvents(kind, tail, lastChange);
  const lastMessage = lastOf(events, "message");
  const verifier = source.role === "independent-verifier";
  const state = agentState(source, silentMs, log);
  const abandonAfterMs = idleTimeoutOf(log);
  return {
    id: source.id,
    runId: log.runId,
    issue: log.issue,
    role: source.role,
    agent: kind,
    model: source.choice.model,
    subtask: source.subtask,
    criterion: source.criterion,
    attempt: source.attempt,
    step: source.step,
    lastTool: verifier ? lastMessage : lastOf(events, "tool"),
    lastMessage: verifier ? null : lastMessage,
    events,
    startedAt: source.startedAt,
    elapsedMs: Math.max(0, endedAt - startedAt),
    silentMs,
    abandonAfterMs,
    abandonInMs: state === "working" || state === "silent" ? Math.max(0, abandonAfterMs - silentMs) : null,
    state,
    outcome: source.ended?.outcome ?? null,
    succeeded: source.ended?.succeeded ?? null,
    tokens: running ? runningTokens(kind, tail) : (source.ended?.tokens ?? null),
  };
}

function workerSource(log: RunLog, subtask: SubtaskRecord, attempt: AttemptRecord): AgentSource {
  return {
    id: `${log.runId}:worker:${subtask.id}:${attempt.number}`,
    role: "worker",
    choice: attempt.agent,
    subtask: subtask.id,
    criterion: null,
    attempt: attempt.number,
    step: subtask.state,
    logPath: attempt.logPath,
    startedAt: attempt.startedAt,
    quietSince: new Date(attempt.startedAt),
    ended:
      attempt.outcome === "running"
        ? null
        : { endedAt: attempt.endedAt, outcome: attempt.outcome, succeeded: attempt.outcome === "completed", tokens: tokenCounts(attempt.usage) },
  };
}

function verifierSources(log: RunLog, subtask: SubtaskRecord): AgentSource[] {
  const choice = log.agents.verifier;
  if (choice === undefined) return [];
  const source = (id: string, logPath: string, startedAt: string) => ({
    id: `${log.runId}:independent-verifier:${subtask.id}:${id}`,
    role: "independent-verifier" as const,
    choice,
    subtask: subtask.id,
    criterion: id,
    attempt: Math.max(1, subtask.attempts.length),
    step: subtask.state,
    logPath,
    startedAt,
    quietSince: new Date(startedAt),
  });
  const question = subtask.verifierQuestion;
  const ended = (subtask.gate?.verifier ?? [])
    .filter((record): record is VerifierRecord & { startedAt: string } => record.startedAt !== undefined && record.id !== question?.id)
    .map((record) => ({ ...source(record.id, record.logPath, record.startedAt), ended: { endedAt: record.endedAt, outcome: record.verdict, succeeded: record.verdict === "accept", tokens: null } }));
  return question === undefined ? ended : [...ended, { ...source(question.id, question.logPath, question.startedAt), ended: null }];
}

function testerVerdict(tester: TesterRecord): string {
  if (tester.error !== undefined) return "error";
  return tester.verdicts.every((verdict) => verdict.passed) ? "passed" : "failed";
}

function testerSource(entry: RunEntry): AgentSource | null {
  const { log } = entry;
  const verification = log.verification;
  if (verification === undefined) return null;
  const { tester, testerPhase, testerStartedAt } = verification;
  const base = { id: `${log.runId}:acceptance-tester:${verification.sha}`, role: "acceptance-tester" as const, subtask: null, criterion: null, attempt: 1 };
  if (testerPhase !== undefined && testerStartedAt !== undefined && log.agents.tester !== undefined) {
    return {
      ...base,
      choice: log.agents.tester,
      step: testerPhase,
      logPath: verification.testerLogPath,
      startedAt: testerStartedAt,
      quietSince: entry.modifiedAt,
      ended: null,
    };
  }
  if (tester?.startedAt === undefined) return null;
  return {
    ...base,
    choice: tester.agent,
    step: "testing",
    logPath: tester.logPath,
    startedAt: tester.startedAt,
    quietSince: new Date(tester.startedAt),
    ended: { endedAt: tester.endedAt, outcome: testerVerdict(tester), succeeded: testerVerdict(tester) === "passed", tokens: tokenCounts(log.testerUsage?.[tester.agent.agent] ?? emptyUsage()) },
  };
}

function agentSources(entry: RunEntry): AgentSource[] {
  const { log } = entry;
  const subtasks = log.subtasks.flatMap((subtask) => [
    ...subtask.attempts.map((attempt) => workerSource(log, subtask, attempt)),
    ...verifierSources(log, subtask),
  ]);
  const tester = testerSource(entry);
  return tester === null ? subtasks : [...subtasks, tester];
}

export function titleOf(log: RunLog): string {
  return log.integrationBranch.replace(/^factory\//, "").replace(/^[0-9]+-/, "").replaceAll("-", " ");
}

function runStep(agents: readonly LiveAgent[]): string {
  const active = agents.filter((agent) => agent.state !== "ended");
  const tester = active.find((agent) => agent.role === "acceptance-tester");
  if (tester !== undefined) return `Acceptance tester · ${tester.step}`;
  const subtasks = [...new Set(active.flatMap((agent) => (agent.subtask === null ? [] : [agent.subtask])))];
  return subtasks.length === 0 ? "Esperando el siguiente paso" : `Subtareas · ${subtasks.join(", ")}`;
}

export function liveRun(entry: RunEntry, tails: RawLogTails, now: Date): LiveRun {
  const agents = agentSources(entry).map((source) => liveAgent(entry, source, tails, now));
  return { runId: entry.log.runId, issue: entry.log.issue, title: titleOf(entry.log), step: runStep(agents), startedAt: entry.log.startedAt, agents };
}

export function runInProgress(entry: RunEntry, now: Date): boolean {
  return entry.log.result === "running" && !runAbandoned(entry, now);
}

export function runsInProgress(entries: readonly RunEntry[], now: Date): RunEntry[] {
  return entries.filter((entry) => runInProgress(entry, now));
}

export function rawLogsOf(entry: RunEntry): string[] {
  return agentSources(entry).flatMap((source) => (source.logPath === undefined ? [] : [source.logPath]));
}

function isAtWork(agent: LiveAgent): boolean {
  return agent.state === "working" || agent.state === "silent";
}

export function liveAnswer(runs: LiveRun[], now: Date, keepAsking: boolean): LiveResponse {
  const atWork = runs.flatMap((run) => run.agents).filter(isAtWork).length;
  return { now: now.toISOString(), inProgress: keepAsking || atWork > 0, atWork, runs };
}

export function liveResponse(entries: readonly RunEntry[], tails: RawLogTails, now: Date): LiveResponse {
  const runs = runsInProgress(entries, now)
    .map((entry) => liveRun(entry, tails, now))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return liveAnswer(runs, now, runs.length > 0);
}
