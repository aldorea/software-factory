// PROTOTYPE (throwaway, branch prototype/web-react-live): replays real raw attempt logs in memory to fake "live" agents.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { idleTimeoutOf, runStatus, abandonedLogs } from "../../coordinator/abandoned.ts";
import { readRunEntries, type RunEntry } from "../../coordinator/run-history.ts";
import type { RunLog, SubtaskRecord } from "../../coordinator/run-log.ts";
import { summarizeRuns, type RunStats } from "../../coordinator/stats.ts";
import { claudeActivity, initialClaudeState, applyClaudeLine } from "../../workers/claude-code.ts";
import { openCodeActivity } from "../../workers/opencode.ts";
import type { ActivityEvent } from "../../workers/types.ts";

export type Role = "worker" | "verifier" | "tester";
export type CardState = "working" | "silent" | "abandoned" | "finished";

export interface ActivityItem {
  at: string;
  kind: ActivityEvent["kind"];
  text: string;
}

export interface AgentCard {
  id: string;
  runId: string;
  issue: number;
  role: Role;
  agent: string;
  model: string;
  subtask: string | null;
  criterion: string | null;
  attempt: number;
  step: string;
  lastTool: string | null;
  lastMessage: string | null;
  events: ActivityItem[];
  startedAt: string;
  elapsedMs: number;
  silentMs: number;
  abandonAfterMs: number;
  state: CardState;
  outcome: string | null;
  tokens: { input: number; output: number; cacheRead: number };
  progress: number;
  replay: { speed: number; source: string };
}

export interface LiveRun {
  runId: string;
  issue: number;
  title: string;
  branch: string;
  step: string;
  startedAt: string;
  cards: AgentCard[];
}

export interface LiveResponse {
  now: string;
  inProgress: boolean;
  runs: LiveRun[];
}

export interface RunRow {
  runId: string;
  issue: number;
  title: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  lastChange: string;
  line: string;
  pullRequest: { number: number; url: string; draft: boolean } | null;
  attempts: number;
  tokens: number;
  live: number;
}

export interface Cause {
  tone: "bad" | "warn" | "info";
  where: string;
  what: string;
  detail: string | null;
  next: string | null;
}

export interface Step {
  name: string;
  state: "passed" | "failed" | "running" | "pending" | "not-run";
  detail: string;
}

export interface RunDetail {
  row: RunRow;
  log: RunLog;
  causes: Cause[];
  steps: Step[];
  cards: AgentCard[];
}

interface Line {
  at: number;
  events: ActivityEvent[];
}

interface Slot {
  id: string;
  runId: string;
  role: Role;
  subtask: string | null;
  criterion: string | null;
  attempt: number;
  agent: string;
  model: string;
  start: number;
  end: number;
  cutAt: number | null;
  outcome: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number };
  offsetMs: number;
  speed: number;
  source: string;
  lines: Line[];
}

const HOLD_FINISHED_MS = 25_000;
const GAP_MS = 4_000;
const EVENTS = 20;

const FACTORY_PATH = /\/[^\s"']*?\/\.factory\/(?:worktrees|logs)\/[^/\s"']+(\/?)/g;
const strip = (text: string) => text.replace(FACTORY_PATH, (_match, slash: string) => (slash === "/" ? "" : "."));

function shorten(event: ActivityEvent): ActivityEvent {
  if (event.kind === "tool" && event.target !== undefined) return { ...event, target: strip(event.target) };
  if (event.kind === "message") return { ...event, text: strip(event.text) };
  return event;
}

function describe(event: ActivityEvent): string {
  if (event.kind === "message") return event.text;
  if (event.kind === "tool") return event.target === undefined ? event.tool : `${event.tool} ${event.target}`;
  return event.outcome === "completed" ? "attempt ended" : "attempt failed";
}

async function loadLines(path: string, agent: string, start: number, end: number): Promise<Line[]> {
  const raw = (await readFile(path, "utf8")).split("\n").filter((line) => line.trim() !== "");
  if (agent === "opencode") {
    return raw.map((line, index) => {
      let at = start + ((end - start) * index) / Math.max(1, raw.length);
      try {
        const parsed = JSON.parse(line) as { timestamp?: unknown };
        if (typeof parsed.timestamp === "number") at = parsed.timestamp;
      } catch {}
      return { at, events: openCodeActivity(line).map(shorten) };
    });
  }
  let state = initialClaudeState();
  return raw.map((line, index) => {
    state = applyClaudeLine(state, line);
    return { at: start + ((end - start) * index) / Math.max(1, raw.length), events: claudeActivity(state, line).map(shorten) };
  });
}

function titleOf(log: RunLog): string {
  const slug = log.integrationBranch.replace(/^factory\//, "").replace(/^\d+-/, "");
  return slug.replace(/-/g, " ");
}

function testerPhase(progress: number): string {
  if (progress < 0.08) return "install";
  if (progress < 0.14) return "start";
  if (progress < 0.18) return "ready";
  return "testing";
}

export class LiveWorld {
  private slots: Slot[] = [];
  private readonly startedAt: number;
  private readonly logsDir: string;

  constructor(repoDir: string, now: number) {
    this.logsDir = join(repoDir, ".factory", "logs");
    this.startedAt = now;
  }

  async load(): Promise<void> {
    const { runs } = await readRunEntries(this.logsDir);
    const byId = new Map(runs.map((entry) => [entry.dir, entry]));
    const add = async (
      runId: string,
      pick: (log: RunLog) => { subtask: SubtaskRecord | null; attempt: number } | null,
      options: { role: Role; criterion?: string; offsetMs: number; speed: number; cut?: number; logFile?: string },
    ) => {
      const entry = byId.get(runId);
      if (entry === undefined) return;
      const log = entry.log;
      const chosen = pick(log);
      if (chosen === null) return;
      const record = chosen.subtask?.attempts.find((attempt) => attempt.number === chosen.attempt);
      const tester = log.verification?.tester;
      const logFile = options.logFile ?? record?.logPath ?? tester?.logPath;
      if (logFile === undefined) return;
      const path = logFile.startsWith("/") ? logFile : join(this.logsDir, runId, logFile);
      const agent = record?.agent ?? tester?.agent ?? log.agents.workers;
      let start = Date.parse(record?.startedAt ?? log.startedAt);
      let end = Date.parse(record?.endedAt ?? log.endedAt ?? log.startedAt);
      const outcome = record?.outcome ?? (tester?.error !== undefined ? "agent-error" : "completed");
      const idle = idleTimeoutOf(log);
      const quietEnd = outcome === "idle-timeout" ? Math.max(start + 1000, end - idle) : end;
      let lines = await loadLines(path, agent.agent, start, quietEnd);
      if (record === undefined && lines.length > 0) {
        start = lines[0]!.at;
        end = lines.at(-1)!.at;
      }
      const usage = record?.usage ?? Object.values(log.testerUsage ?? {})[0] ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
      const cutAt = options.cut === undefined ? null : start + (end - start) * options.cut;
      if (cutAt !== null) lines = lines.filter((line) => line.at <= cutAt);
      this.slots.push({
        id: `${runId}:${options.role}:${chosen.subtask?.id ?? options.criterion ?? "tester"}:${chosen.attempt}`,
        runId,
        role: options.role,
        subtask: chosen.subtask?.id ?? null,
        criterion: options.criterion ?? null,
        attempt: chosen.attempt,
        agent: agent.agent,
        model: agent.model,
        start,
        end,
        cutAt,
        outcome,
        usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadInputTokens: usage.cacheReadInputTokens },
        offsetMs: options.offsetMs,
        speed: options.speed,
        source: path.split("/").pop() ?? path,
        lines,
      });
    };
    const subtask = (id: string, attempt: number) => (log: RunLog) => {
      const found = log.subtasks.find((candidate) => candidate.id === id);
      return found === undefined ? null : { subtask: found, attempt };
    };
    await add("28-2026-11-02T08-55-44-715Z", subtask("summary-core", 1), { role: "worker", offsetMs: 0, speed: 8 });
    await add("28-2026-11-02T08-55-44-715Z", subtask("summary-ui", 1), { role: "worker", offsetMs: 6_000, speed: 8 });
    await add("23-2026-10-27T07-40-57-429Z", subtask("health", 3), { role: "worker", offsetMs: 0, speed: 2 });
    await add("23-2026-10-27T07-40-57-429Z", subtask("health", 2), { role: "verifier", criterion: "A2", offsetMs: 20_000, speed: 2 });
    await add("23-2026-10-26T20-12-40-146Z", subtask("health", 1), { role: "worker", offsetMs: 3_000, speed: 8 });
    await add("28-2026-11-02T10-57-18-161Z", () => ({ subtask: null, attempt: 1 }), { role: "tester", offsetMs: 0, speed: 8 });
    await add("27-2026-10-28T09-09-10-365Z", subtask("deleted-option", 2), { role: "worker", offsetMs: 0, speed: 8, cut: 0.15 });
  }

  private card(slot: Slot, log: RunLog, now: number): AgentCard | null {
    const real = now - this.startedAt - slot.offsetMs;
    if (real < 0) return null;
    const playMs = (slot.end - slot.start) / slot.speed;
    const cycle = slot.cutAt === null ? playMs + HOLD_FINISHED_MS + GAP_MS : Number.POSITIVE_INFINITY;
    const inCycle = real % cycle;
    if (inCycle > playMs + HOLD_FINISHED_MS) return null;
    const simNow = Math.min(slot.start + inCycle * slot.speed, slot.cutAt === null ? slot.end : Number.POSITIVE_INFINITY);
    const seen = slot.lines.filter((line) => line.at <= simNow);
    const finished = slot.cutAt === null && simNow >= slot.end;
    const events = seen.flatMap((line) => line.events.map((event) => ({ at: new Date(line.at).toISOString(), kind: event.kind, text: describe(event) })));
    const lastAt = seen.at(-1)?.at ?? slot.start;
    const idle = idleTimeoutOf(log);
    const silentMs = finished ? 0 : simNow - lastAt;
    const progress = slot.lines.length === 0 ? 1 : seen.length / slot.lines.length;
    const lastTool = [...events].reverse().find((event) => event.kind === "tool")?.text ?? null;
    const lastMessage = [...events].reverse().find((event) => event.kind === "message")?.text ?? null;
    const state: CardState = finished ? "finished" : silentMs > idle ? "abandoned" : silentMs > 60_000 ? "silent" : "working";
    const step =
      slot.role === "tester"
        ? `Acceptance tester · ${testerPhase(progress)}`
        : slot.role === "verifier"
          ? `Independent verifier · ${slot.criterion} of ${slot.subtask}`
          : `Subtask ${slot.subtask} · attempt ${slot.attempt}`;
    return {
      id: slot.id,
      runId: slot.runId,
      issue: log.issue,
      role: slot.role,
      agent: slot.agent,
      model: slot.model,
      subtask: slot.subtask,
      criterion: slot.criterion,
      attempt: slot.attempt,
      step,
      lastTool,
      lastMessage,
      events: events.slice(-EVENTS),
      startedAt: new Date(slot.start).toISOString(),
      elapsedMs: Math.min(simNow, slot.cutAt ?? simNow) - slot.start + (slot.cutAt !== null ? Math.max(0, simNow - slot.cutAt) : 0),
      silentMs,
      abandonAfterMs: idle,
      state,
      outcome: finished ? slot.outcome : null,
      tokens: {
        input: Math.round(slot.usage.inputTokens * progress),
        output: Math.round(slot.usage.outputTokens * progress),
        cacheRead: Math.round(slot.usage.cacheReadInputTokens * progress),
      },
      progress,
      replay: { speed: slot.speed, source: slot.source },
    };
  }

  async cards(now: number): Promise<{ cards: AgentCard[]; entries: RunEntry[] }> {
    const { runs } = await readRunEntries(this.logsDir);
    const byId = new Map(runs.map((entry) => [entry.dir, entry]));
    const cards = this.slots.flatMap((slot) => {
      const entry = byId.get(slot.runId);
      if (entry === undefined) return [];
      const card = this.card(slot, entry.log, now);
      return card === null ? [] : [card];
    });
    return { cards, entries: runs };
  }

  async live(now: number): Promise<LiveResponse> {
    const { cards, entries } = await this.cards(now);
    const runs: LiveRun[] = [];
    for (const entry of entries) {
      const own = cards.filter((card) => card.runId === entry.dir);
      if (own.length === 0) continue;
      runs.push({
        runId: entry.dir,
        issue: entry.log.issue,
        title: titleOf(entry.log),
        branch: entry.log.integrationBranch,
        step: runStep(own),
        startedAt: entry.log.startedAt,
        cards: own,
      });
    }
    runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return { now: new Date(now).toISOString(), inProgress: cards.some((card) => card.state === "working" || card.state === "silent"), runs };
  }

  async runs(now: number): Promise<{ rows: RunRow[]; stats: RunStats }> {
    const { cards, entries } = await this.cards(now);
    const date = new Date(now);
    const rows = entries.map((entry) => rowOf(entry, cards.filter((card) => card.runId === entry.dir), date)).reverse();
    return { rows, stats: summarizeRuns(entries.map((entry) => entry.log), abandonedLogs(entries, date)) };
  }

  async run(runId: string, now: number): Promise<RunDetail | null> {
    const { cards, entries } = await this.cards(now);
    const entry = entries.find((candidate) => candidate.dir === runId);
    if (entry === undefined) return null;
    const own = cards.filter((card) => card.runId === runId);
    const row = rowOf(entry, own, new Date(now));
    return { row, log: entry.log, causes: row.status === "running" ? [] : causesOf(entry.log, row.status), steps: stepsOf(entry.log, own), cards: own };
  }
}

function runStep(cards: AgentCard[]): string {
  const active = cards.filter((card) => card.state !== "finished");
  if (active.length === 0) return "Waiting for the next step";
  const tester = active.find((card) => card.role === "tester");
  if (tester !== undefined) return `Integrated verification · ${tester.step.split(" · ")[1]}`;
  return active.map((card) => (card.role === "verifier" ? `verifier ${card.criterion}` : `${card.subtask} #${card.attempt}`)).join(", ");
}

function rowOf(entry: RunEntry, cards: AgentCard[], now: Date): RunRow {
  const log = entry.log;
  const live = cards.filter((card) => card.state === "working" || card.state === "silent").length;
  const status = live > 0 ? "running" : cards.some((card) => card.state === "abandoned") ? "abandoned" : runStatus(entry, now);
  const attempts = log.subtasks.reduce((total, subtask) => total + subtask.attempts.length, 0);
  const tokens = log.cost.usage.inputTokens + log.cost.usage.outputTokens + log.cost.usage.cacheCreationInputTokens;
  const first = causesOf(log, status)[0];
  return {
    runId: entry.dir,
    issue: log.issue,
    title: titleOf(log),
    status,
    startedAt: log.startedAt,
    endedAt: log.endedAt ?? null,
    lastChange: (live > 0 ? now : entry.modifiedAt).toISOString(),
    line: live > 0 ? runStep(cards) : first === undefined ? "All criteria pass" : `${first.where}: ${first.what}`,
    pullRequest: log.pullRequest ?? null,
    attempts,
    tokens,
    live,
  };
}

function causesOf(log: RunLog, status: string): Cause[] {
  const causes: Cause[] = [];
  if (status === "abandoned") causes.push({ tone: "bad", where: "Run", what: "abandoned", detail: "No file of the run changed for longer than the idle threshold.", next: `factory run ${log.issue}` });
  if (status === "paused") causes.push({ tone: "warn", where: "Run", what: "paused", detail: null, next: `factory run ${log.issue}` });
  for (const subtask of log.subtasks) {
    if (subtask.state !== "blocked") continue;
    const type = subtask.blockType ?? subtask.block?.type ?? "blocked";
    const reason = subtask.reason ?? subtask.block?.reason ?? null;
    causes.push({ tone: "bad", where: `Subtask ${subtask.id}`, what: `blocked (${type})`, detail: reason, next: type === "scope" || type === "design-question" ? "Review the spec, then start a new run" : `factory run ${log.issue}` });
  }
  for (const check of log.verification?.checks ?? []) {
    if (!check.passed) causes.push({ tone: "bad", where: "Integrated verification", what: `check ${check.name} failed`, detail: check.firstError ?? null, next: null });
  }
  for (const criterion of log.verification?.criteria ?? []) {
    if (!criterion.passed) causes.push({ tone: "bad", where: "Integrated verification", what: `criterion ${criterion.id} failed`, detail: null, next: null });
  }
  const tester = log.verification?.tester;
  if (tester?.error !== undefined) causes.push({ tone: "bad", where: "Acceptance tester", what: "error", detail: tester.error, next: `factory run ${log.issue}` });
  for (const verdict of tester?.verdicts ?? []) {
    if (!verdict.passed) causes.push({ tone: "warn", where: "Acceptance tester", what: `${verdict.id} failed`, detail: verdict.observation, next: null });
  }
  if (causes.length === 0 && log.result === "draft") causes.push({ tone: "info", where: "Pull request", what: "draft", detail: `Pending criteria: ${log.criteria.pending.join(", ") || "none"}`, next: null });
  return causes;
}

function stepsOf(log: RunLog, cards: AgentCard[]): Step[] {
  const steps: Step[] = log.subtasks.map((subtask) => {
    const live = cards.find((card) => card.subtask === subtask.id && card.state !== "finished");
    const state: Step["state"] = live !== undefined ? "running" : subtask.state === "merged" ? "passed" : subtask.state === "blocked" ? "failed" : subtask.state === "not-started" ? "not-run" : "pending";
    const detail = subtask.attempts.length === 0 ? (subtask.reason ?? "no attempts in this run") : `${subtask.attempts.length} attempt(s), gate ${subtask.gate?.accepted ? "accepted" : subtask.gate ? "rejected" : "not run"}`;
    return { name: `Subtask ${subtask.id}`, state, detail };
  });
  const verification = log.verification;
  const tester = cards.find((card) => card.role === "tester" && card.state !== "finished");
  steps.push({
    name: "Integrated verification",
    state: tester !== undefined ? "running" : verification === undefined ? "pending" : verification.passed ? "passed" : "failed",
    detail: verification === undefined ? "not reached" : `${verification.checks.filter((check) => check.passed).length}/${verification.checks.length} checks, ${verification.criteria.filter((criterion) => criterion.passed).length}/${verification.criteria.length} criteria`,
  });
  steps.push({
    name: "Acceptance tester",
    state: tester !== undefined ? "running" : verification?.tester === undefined ? "not-run" : verification.tester.error !== undefined ? "failed" : "passed",
    detail: tester !== undefined ? tester.step : verification?.tester?.error ?? `${verification?.tester?.verdicts.length ?? 0} verdicts`,
  });
  steps.push({
    name: "Publication",
    state: log.pullRequest !== undefined ? "passed" : log.result === "running" ? "pending" : "not-run",
    detail: log.pullRequest !== undefined ? `PR #${log.pullRequest.number}${log.pullRequest.draft ? " (draft)" : ""}` : "no pull request",
  });
  return steps;
}
