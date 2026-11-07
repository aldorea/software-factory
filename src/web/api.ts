import { abandonedLogs, runStatus, type RunStatus } from "../coordinator/abandoned.ts";
import type { RunEntries, RunEntry } from "../coordinator/run-history.ts";
import { isUnpublished } from "../coordinator/run-log.ts";
import { summarizeRuns, type RunStats } from "../coordinator/stats.ts";
import { WORKER_LAYER_FAILURE_KINDS } from "../workers/failures.ts";
import { liveRun, runInProgress, type LiveEvent, type LiveRun, type RawLogTails } from "./live.ts";
import { runCauses } from "./run-causes.ts";
import { safeLink } from "./safe-link.ts";
import { parseRunId } from "./routes.ts";

export type PullRequestCell =
  | { kind: "none" }
  | { kind: "not-published" }
  | { kind: "pull-request"; number: number; url: string | null };

export interface RunRow {
  issue: number;
  runId: string;
  href: string | null;
  status: RunStatus;
  modifiedAt: string;
  pullRequest: PullRequestCell;
  line: string | null;
}

export interface RunsResponse {
  now: string;
  runs: RunRow[];
  unreadable: string[];
  stats: RunStats | null;
  inProgress: boolean;
}

export interface ApiError {
  error: string;
}

function pullRequestCell(entry: RunEntry): PullRequestCell {
  if (isUnpublished(entry.log)) return { kind: "not-published" };
  const pullRequest = entry.log.pullRequest;
  if (pullRequest === undefined) return { kind: "none" };
  return { kind: "pull-request", number: pullRequest.number, url: safeLink(pullRequest.url) };
}

function lastEvent(run: LiveRun): LiveEvent | null {
  const events = run.agents.flatMap((agent) => agent.events);
  return events.reduce<LiveEvent | null>((last, event) => (last === null || event.at >= last.at ? event : last), null);
}

function runLine(entry: RunEntry, tails: RawLogTails, now: Date): string | null {
  if (runInProgress(entry, now)) {
    const run = liveRun(entry, tails, now);
    return lastEvent(run)?.text ?? run.step;
  }
  const cause = runCauses(entry, now)[0];
  return cause === undefined ? null : `${cause.where}: ${cause.what}`;
}

function runRow(entry: RunEntry, tails: RawLogTails, now: Date): RunRow {
  return {
    issue: entry.log.issue,
    runId: entry.log.runId,
    href: parseRunId(entry.dir) === null ? null : `/runs/${entry.dir}`,
    status: runStatus(entry, now),
    modifiedAt: entry.modifiedAt.toISOString(),
    pullRequest: pullRequestCell(entry),
    line: runLine(entry, tails, now),
  };
}

function inKindOrder(stats: RunStats): RunStats {
  const failures = WORKER_LAYER_FAILURE_KINDS.flatMap((kind) => {
    const count = stats.workerLayerFailures[kind];
    return count === undefined ? [] : [[kind, count] as const];
  });
  return { ...stats, workerLayerFailures: Object.fromEntries(failures) };
}

export function runsResponse({ runs, unreadable }: RunEntries, now: Date, tails: RawLogTails = new Map()): RunsResponse {
  const rows = [...runs].reverse().map((entry) => runRow(entry, tails, now));
  return {
    now: now.toISOString(),
    runs: rows,
    unreadable,
    stats: runs.length === 0 ? null : inKindOrder(summarizeRuns(runs.map((entry) => entry.log), abandonedLogs(runs, now))),
    inProgress: rows.some((row) => row.status === "running"),
  };
}
