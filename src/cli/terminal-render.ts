import type { ActivityEntry } from "../coordinator/ports.ts";
import type { RunLog } from "../coordinator/run-log.ts";
import { activityLine, clockTime, describe } from "./activity-line.ts";

const ESC = String.fromCharCode(27);
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[2m`;
const GREEN = `${ESC}[32m`;
const RED = `${ESC}[31m`;
const YELLOW = `${ESC}[33m`;
const PREFIX_COLOURS = [36, 35, 34, 96, 95, 94].map((code) => `${ESC}[${code}m`);

export const CLEAR_LINE = `\r${ESC}[2K`;

export interface RunningAttempt {
  source: string;
  number: number;
  startedAt: Date;
}

function paint(code: string, text: string): string {
  return `${code}${text}${RESET}`;
}

export function renderProgress(line: string, color: boolean): string {
  if (!color) return line;
  if (/^[^\s:]+: merged$/.test(line)) return paint(GREEN, line);
  if (/^[^\s:]+: blocked( \(.*\))?$/.test(line)) return paint(RED, line);
  if (/^run paused: /.test(line) || /^run \S+: paused$/.test(line)) return paint(YELLOW, line);
  return line;
}

export function renderActivity(entry: ActivityEntry, color: boolean): string {
  if (!color) return activityLine(entry);
  const prefix = PREFIX_COLOURS[sourceHash(entry.source) % PREFIX_COLOURS.length] as string;
  return `${paint(DIM, `${clockTime(entry.at)} `)}${paint(prefix, entry.source)}${paint(DIM, ` · ${describe(entry.event)}`)}`;
}

function sourceHash(source: string): number {
  return [...source].reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

export function runningAttempts(log: RunLog): RunningAttempt[] {
  return log.subtasks.flatMap((record) =>
    record.attempts
      .filter((attempt) => attempt.outcome === "running")
      .map((attempt) => ({ source: record.id, number: attempt.number, startedAt: new Date(attempt.startedAt) })),
  );
}

export function statusLine(attempts: RunningAttempt[], lastActivity: ReadonlyMap<string, Date>, now: Date): string {
  return attempts
    .map((attempt) => {
      const last = lastActivity.get(attempt.source);
      const since = last === undefined ? "no activity yet" : `last activity ${duration(now.getTime() - last.getTime())} ago`;
      return `⏳ ${attempt.source} attempt ${attempt.number} · ${duration(now.getTime() - attempt.startedAt.getTime())} · ${since}`;
    })
    .join("   ");
}

function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (value: number) => String(value).padStart(2, "0");
  if (hours > 0) return `${hours}h${two(minutes)}m${two(seconds)}s`;
  if (minutes > 0) return `${minutes}m${two(seconds)}s`;
  return `${seconds}s`;
}
