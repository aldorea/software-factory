import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { DEFAULT_LIMITS } from "../../src/config/config.ts";
import { writeRunLog, type RunLog } from "../../src/coordinator/run-log.ts";
import { handleRequest, type WebRequest } from "../../src/web/handler.ts";
import { cleanRun } from "../coordinator/run-log-fixtures.ts";
import { tempDirs } from "../temp-dirs.ts";

export const temp = tempDirs();

export const NOW = new Date("2026-10-24T08:00:00.000Z");
export const PORT = 7433;

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
  return { method: "GET", path, host: `127.0.0.1:${PORT}`, repoDir, port: PORT, now: NOW, idleTimeoutMs: DEFAULT_LIMITS.run.attemptIdleTimeoutMs, ...overrides };
}

export async function runPage(log: RunLog, modifiedAt?: Date): Promise<string> {
  const dir = await repoWithRuns([{ log, modifiedAt }]);
  const response = await handleRequest(request(dir, `/runs/${log.runId}`));
  expect(response.status).toBe(200);
  expect(response.contentType).toBe("text/html; charset=utf-8");
  return response.body;
}

export function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ");
}
