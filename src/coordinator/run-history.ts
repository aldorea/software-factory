import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execOk } from "../workers/sh.ts";
import { parseRunLog, type RunLog } from "./run-log.ts";

export const SUBTASK_TRAILER = "Factory-Subtask";

export async function mergedSubtasks(repoDir: string, branch: string): Promise<Set<string>> {
  const out = await execOk("git", [
    "-C",
    repoDir,
    "log",
    "--merges",
    `--format=%(trailers:key=${SUBTASK_TRAILER},valueonly)`,
    branch,
  ]);
  return new Set(
    out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );
}

export async function runBaseSha(repoDir: string, branch: string): Promise<string> {
  const out = await execOk("git", [
    "-C",
    repoDir,
    "log",
    "--merges",
    "--reverse",
    `--format=%H%x09%(trailers:key=${SUBTASK_TRAILER},valueonly,separator=%x2C)`,
    branch,
  ]);
  const firstMerge = out
    .split("\n")
    .map((line) => line.split("\t"))
    .find(([, subtasks]) => subtasks !== undefined && subtasks.trim() !== "")?.[0];
  return (await execOk("git", ["-C", repoDir, "rev-parse", firstMerge === undefined ? branch : `${firstMerge}^1`])).trim();
}

export interface RunLogs {
  logs: RunLog[];
  unreadable: string[];
}

export async function readRunLogs(logsDir: string): Promise<RunLogs> {
  const entries = (await readdir(logsDir).catch(() => [] as string[])).sort();
  const logs: RunLog[] = [];
  const unreadable: string[] = [];
  for (const entry of entries) {
    const text = await readFile(join(logsDir, entry, "run.json"), "utf8").catch(() => null);
    if (text === null) continue;
    const parsed = parseRunLog(text);
    if (parsed.ok) logs.push(parsed.log);
    else unreadable.push(`${entry}/run.json`);
  }
  logs.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  return { logs, unreadable };
}

export async function latestRunLog(logsDir: string, issue: number): Promise<RunLog | null> {
  const entries = await readdir(logsDir).catch(() => [] as string[]);
  const runIds = entries.filter((entry) => entry.startsWith(`${issue}-`)).sort();
  const latest = runIds.at(-1);
  if (latest === undefined) return null;
  const text = await readFile(join(logsDir, latest, "run.json"), "utf8").catch(() => null);
  if (text === null) return null;
  const parsed = parseRunLog(text);
  if (!parsed.ok) throw new Error(`${join(logsDir, latest, "run.json")} cannot be resumed: ${parsed.problem}`);
  return parsed.log;
}
