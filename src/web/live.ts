import { attemptAbandoned, idleTimeoutOf, runAbandoned } from "../coordinator/abandoned.ts";
import type { RunEntry } from "../coordinator/run-history.ts";
import type { AttemptRecord, RunLog, SubtaskRecord } from "../coordinator/run-log.ts";
import { adapterFor } from "../workers/agents.ts";
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
  state: AgentState;
  outcome: string | null;
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

function lineTime(line: string): string | null {
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

function describe(event: ActivityEvent): string {
  if (event.kind === "message") return event.text;
  if (event.kind === "tool") return event.target === undefined ? event.tool : `${event.tool} ${event.target}`;
  return event.outcome === "completed" ? "attempt ended" : "attempt failed";
}

export function rawLogEvents(kind: AgentKind, lines: readonly string[], fallbackAt: Date): LiveEvent[] {
  const stream = adapterFor(kind).createStream();
  let at = fallbackAt.toISOString();
  const events: LiveEvent[] = [];
  for (const line of lines) {
    stream.onLine(line);
    at = lineTime(line) ?? at;
    for (const event of stream.activity?.(line) ?? []) events.push({ at, kind: event.kind, text: describe(event) });
  }
  return events.slice(-LIVE_EVENTS);
}

function lastOf(events: readonly LiveEvent[], kind: LiveEvent["kind"]): string | null {
  return events.findLast((event) => event.kind === kind)?.text ?? null;
}

function counted(usage: TokenUsage): { input: number; output: number } {
  return { input: usage.inputTokens + usage.cacheCreationInputTokens, output: usage.outputTokens };
}

function workerState(attempt: AttemptRecord, entry: RunEntry, silentMs: number, now: Date): AgentState {
  if (attempt.outcome !== "running") return "ended";
  if (attemptAbandoned(attempt, entry, now)) return "abandoned";
  return silentMs > SILENT_AFTER_MS ? "silent" : "working";
}

function worker(entry: RunEntry, subtask: SubtaskRecord, attempt: AttemptRecord, tails: RawLogTails, now: Date): LiveAgent {
  const { log } = entry;
  const running = attempt.outcome === "running";
  const startedAt = Date.parse(attempt.startedAt);
  const lastChange = entry.logTimes.get(attempt.logPath) ?? new Date(startedAt);
  const silentMs = running ? Math.max(0, now.getTime() - lastChange.getTime()) : 0;
  const endedAt = running || attempt.endedAt === undefined ? now.getTime() : Date.parse(attempt.endedAt);
  const events = running ? rawLogEvents(attempt.agent.agent, tails.get(attempt.logPath) ?? [], lastChange) : [];
  return {
    id: `${log.runId}:worker:${subtask.id}:${attempt.number}`,
    runId: log.runId,
    issue: log.issue,
    role: "worker",
    agent: attempt.agent.agent,
    model: attempt.agent.model,
    subtask: subtask.id,
    criterion: null,
    attempt: attempt.number,
    step: subtask.state,
    lastTool: lastOf(events, "tool"),
    lastMessage: lastOf(events, "message"),
    events,
    startedAt: attempt.startedAt,
    elapsedMs: Math.max(0, endedAt - startedAt),
    silentMs,
    abandonAfterMs: idleTimeoutOf(log),
    state: workerState(attempt, entry, silentMs, now),
    outcome: running ? null : attempt.outcome,
    tokens: running ? null : counted(attempt.usage),
  };
}

export function titleOf(log: RunLog): string {
  return log.integrationBranch.replace(/^factory\//, "").replace(/^[0-9]+-/, "").replaceAll("-", " ");
}

function runStep(agents: readonly LiveAgent[]): string {
  const subtasks = [...new Set(agents.filter((agent) => agent.state !== "ended").map((agent) => agent.subtask))];
  return subtasks.length === 0 ? "Waiting for the next step" : `Subtasks · ${subtasks.join(", ")}`;
}

export function liveRun(entry: RunEntry, tails: RawLogTails, now: Date): LiveRun {
  const agents = entry.log.subtasks.flatMap((subtask) => subtask.attempts.map((attempt) => worker(entry, subtask, attempt, tails, now)));
  return { runId: entry.log.runId, issue: entry.log.issue, title: titleOf(entry.log), step: runStep(agents), startedAt: entry.log.startedAt, agents };
}

export function runsInProgress(entries: readonly RunEntry[], now: Date): RunEntry[] {
  return entries.filter((entry) => entry.log.result === "running" && !runAbandoned(entry, now));
}

export function attemptsInProgress(entry: RunEntry): AttemptRecord[] {
  return entry.log.subtasks.flatMap((subtask) => subtask.attempts.filter((attempt) => attempt.outcome === "running"));
}

export function isAtWork(agent: LiveAgent): boolean {
  return agent.state === "working" || agent.state === "silent";
}

export function liveResponse(entries: readonly RunEntry[], tails: RawLogTails, now: Date): LiveResponse {
  const runs = runsInProgress(entries, now)
    .map((entry) => liveRun(entry, tails, now))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const atWork = runs.flatMap((run) => run.agents).filter(isAtWork).length;
  return { now: now.toISOString(), inProgress: atWork > 0, atWork, runs };
}
