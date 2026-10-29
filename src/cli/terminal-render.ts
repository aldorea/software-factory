import type { ActivityEntry } from "../coordinator/ports.ts";
import type { RunLog } from "../coordinator/run-log.ts";
import { activityLine, describeActivity } from "./activity-line.ts";
import { clockTime, twoDigits } from "./clock-time.ts";

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

export function renderProgress(line: string, at: Date, color: boolean): string {
  if (!color) return `${clockTime(at)} ${line}`;
  return `${paint(DIM, `${clockTime(at)} `)}${progressColour(line)}`;
}

function progressColour(line: string): string {
  if (/^[^\s:]+: merged$/.test(line)) return paint(GREEN, line);
  if (/^[^\s:]+: blocked( \(.*\))?$/.test(line)) return paint(RED, line);
  if (/^run paused: /.test(line) || /^run \S+: paused$/.test(line)) return paint(YELLOW, line);
  return line;
}

export type SourceColours = (source: string) => string;

export function sourceColours(): SourceColours {
  const order: string[] = [];
  return (source) => {
    if (!order.includes(source)) order.push(source);
    return PREFIX_COLOURS[order.indexOf(source) % PREFIX_COLOURS.length] as string;
  };
}

export function renderActivity(entry: ActivityEntry, color: boolean, colours: SourceColours): string {
  if (!color) return activityLine(entry);
  return `${paint(DIM, `${clockTime(entry.at)} `)}${paint(colours(entry.source), entry.source)}${paint(DIM, ` · ${describeActivity(entry.event)}`)}`;
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
  if (hours > 0) return `${hours}h${twoDigits(minutes)}m${twoDigits(seconds)}s`;
  if (minutes > 0) return `${minutes}m${twoDigits(seconds)}s`;
  return `${seconds}s`;
}
