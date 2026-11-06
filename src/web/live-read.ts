import { open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readRunEntries } from "../coordinator/run-history.ts";
import { attemptsInProgress, liveResponse, runsInProgress, type LiveResponse } from "./live.ts";
import { isInside } from "./log-path.ts";

export const RAW_LOG_TAIL_BYTES = 64 * 1024;

export async function rawLogTail(runDir: string, logPath: string, maxBytes: number = RAW_LOG_TAIL_BYTES): Promise<string[]> {
  const file = await realpath(resolve(runDir, logPath)).catch(() => null);
  const dir = await realpath(runDir).catch(() => null);
  if (file === null || dir === null || !isInside(dir, file)) return [];
  const handle = await open(file, "r").catch(() => null);
  if (handle === null) return [];
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    return (start > 0 ? lines.slice(1) : lines).filter((line) => line.trim() !== "");
  } finally {
    await handle.close();
  }
}

export async function readLive(logsDir: string, now: Date): Promise<LiveResponse> {
  const { runs } = await readRunEntries(logsDir);
  const tails = new Map<string, string[]>();
  for (const entry of runsInProgress(runs, now)) {
    for (const attempt of attemptsInProgress(entry)) {
      tails.set(attempt.logPath, await rawLogTail(join(logsDir, entry.dir), attempt.logPath));
    }
  }
  return liveResponse(runs, tails, now);
}
