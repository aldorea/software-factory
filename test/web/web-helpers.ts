import { utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { writeRunLog, type RunLog } from "../../src/coordinator/run-log.ts";
import { handleRequest, type WebRequest } from "../../src/web/handler.ts";
import type { RunDetail } from "../../src/web/run-detail.ts";
import { cleanRun } from "../coordinator/run-log-fixtures.ts";
import { tempDirs } from "../temp-dirs.ts";

export const temp = tempDirs();

export const NOW = new Date("2026-10-24T08:00:00.000Z");
export const PORT = 7433;
export const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "client");

export function aRun(index: number, overrides: Partial<RunLog> = {}): RunLog {
  const log = { ...cleanRun(index), ...overrides };
  return { ...log, runId: `${log.issue}-2026-10-${String(10 + index).padStart(2, "0")}T08-00-00-000Z` };
}

export async function repoWithRuns(runs: Array<{ log: RunLog; modifiedAt?: Date | undefined }>): Promise<string> {
  const dir = await temp.make("web-run-repo-");
  for (const { log, modifiedAt } of runs) {
    const path = join(dir, ".factory", "logs", log.runId, "run.json");
    await writeRunLog(path, log);
    if (modifiedAt) await utimes(path, modifiedAt, modifiedAt);
  }
  return dir;
}

export function request(repoDir: string, path = "/", overrides: Partial<WebRequest> = {}): WebRequest {
  return { method: "GET", path, host: `127.0.0.1:${PORT}`, repoDir, clientDir: CLIENT_DIR, port: PORT, now: NOW, ...overrides };
}

export async function runDetailIn(dir: string, runId: string): Promise<RunDetail> {
  const response = await handleRequest(request(dir, `/api/runs/${runId}`));
  expect(response.status).toBe(200);
  expect(response.contentType).toBe("application/json; charset=utf-8");
  return JSON.parse(response.body) as RunDetail;
}

export async function runDetail(log: RunLog, modifiedAt?: Date): Promise<RunDetail> {
  const dir = await repoWithRuns([{ log, modifiedAt }]);
  return runDetailIn(dir, log.runId);
}
