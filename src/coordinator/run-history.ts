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
