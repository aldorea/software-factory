import { readdir, readFile, stat } from "node:fs/promises";
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

export interface RunEntry {
  dir: string;
  log: RunLog;
  modifiedAt: Date;
}

export interface RunEntries {
  runs: RunEntry[];
  unreadable: string[];
}

export async function readRunEntries(logsDir: string): Promise<RunEntries> {
  const entries = (await readdir(logsDir).catch(() => [] as string[])).sort();
  const runs: RunEntry[] = [];
  const unreadable: string[] = [];
  for (const entry of entries) {
    const path = join(logsDir, entry, "run.json");
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) continue;
    const parsed = parseRunLog(text);
    if (parsed.ok) runs.push({ dir: entry, log: parsed.log, modifiedAt: (await stat(path)).mtime });
    else unreadable.push(`${entry}/run.json`);
  }
  runs.sort((a, b) => Date.parse(a.log.startedAt) - Date.parse(b.log.startedAt));
  return { runs, unreadable };
}

export async function readRunLogs(logsDir: string): Promise<RunLogs> {
  const { runs, unreadable } = await readRunEntries(logsDir);
  return { logs: runs.map((run) => run.log), unreadable };
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
