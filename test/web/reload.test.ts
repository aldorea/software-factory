import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { writeRunLog, type RunLog } from "../../src/coordinator/run-log.ts";
import { handleRequest } from "../../src/web/handler.ts";
import { shouldReload } from "../../src/web/reload.ts";
import { cleanRun } from "../coordinator/run-log-fixtures.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

const NOW = new Date("2026-10-24T08:00:00.000Z");
const PORT = 7433;
const RELOAD = '<meta http-equiv="refresh" content="5">';

function aRun(index: number, result: RunLog["result"]): RunLog {
  const log = cleanRun(index);
  return { ...log, result, runId: `${log.issue}-2026-10-${String(10 + index).padStart(2, "0")}T08-00-00-000Z` };
}

async function pageOf(logs: RunLog[], path: (logs: RunLog[]) => string): Promise<string> {
  const repoDir = await temp.make("web-reload-repo-");
  for (const log of logs) await writeRunLog(join(repoDir, ".factory", "logs", log.runId, "run.json"), log);
  const response = await handleRequest({ method: "GET", path: path(logs), host: `127.0.0.1:${PORT}`, repoDir, port: PORT, now: NOW });
  expect(response.status).toBe(200);
  return response.body;
}

function firstRunPath([log]: RunLog[]): string {
  return `/runs/${(log as RunLog).runId}`;
}

describe("the decision to reload", () => {
  it("should reload when any run is running", () => {
    expect(shouldReload([aRun(0, "ready"), aRun(1, "running")])).toBe(true);
  });

  it("should not reload when no run is running so the page can be read without jumps", () => {
    expect(shouldReload([aRun(0, "ready"), aRun(1, "draft"), aRun(2, "paused")])).toBe(false);
  });

  it("should not reload with no runs", () => {
    expect(shouldReload([])).toBe(false);
  });
});

describe("the reload of the home page", () => {
  it("should reload every 5 seconds from the HTML when a run is running", async () => {
    const body = await pageOf([aRun(0, "ready"), aRun(1, "running")], () => "/");

    expect(body).toContain(RELOAD);
  });

  it("should not reload when no run is running", async () => {
    const body = await pageOf([aRun(0, "ready"), aRun(1, "paused")], () => "/");

    expect(body).not.toContain("http-equiv");
  });

  it("should not reload with no runs", async () => {
    const body = await pageOf([], () => "/");

    expect(body).not.toContain("http-equiv");
  });
});

describe("the reload of the page of a run", () => {
  it("should reload every 5 seconds from the HTML when the run is running", async () => {
    const body = await pageOf([aRun(0, "running")], firstRunPath);

    expect(body).toContain(RELOAD);
  });

  it.each(["ready", "draft", "paused"] as const)("should not reload when the run is %s", async (result) => {
    const body = await pageOf([aRun(0, result)], firstRunPath);

    expect(body).not.toContain("http-equiv");
  });

  it("should not reload the page of a finished run because another run is running", async () => {
    const body = await pageOf([aRun(0, "ready"), aRun(1, "running")], firstRunPath);

    expect(body).not.toContain("http-equiv");
  });
});
