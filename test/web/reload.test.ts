import { afterEach, describe, expect, it } from "vitest";
import type { RunLog } from "../../src/coordinator/run-log.ts";
import { handleRequest } from "../../src/web/handler.ts";
import { shouldReload } from "../../src/web/reload.ts";
import { aRun, repoWithRuns, request, temp } from "./web-helpers.ts";

afterEach(() => temp.removeAll());

const RELOAD = '<meta http-equiv="refresh" content="5">';

async function pageOf(logs: RunLog[], path: (logs: RunLog[]) => string): Promise<string> {
  const repoDir = await repoWithRuns(logs.map((log) => ({ log })));
  const response = await handleRequest(request(repoDir, path(logs)));
  expect(response.status).toBe(200);
  return response.body;
}

function firstRunPath([log]: RunLog[]): string {
  return `/runs/${(log as RunLog).runId}`;
}

describe("the decision to reload", () => {
  it("should reload when any run is running", () => {
    expect(shouldReload([aRun(0, { result: "ready" }), aRun(1, { result: "running" })])).toBe(true);
  });

  it("should not reload when no run is running so the page can be read without jumps", () => {
    expect(shouldReload([aRun(0, { result: "ready" }), aRun(1, { result: "draft" }), aRun(2, { result: "paused" })])).toBe(false);
  });

  it("should not reload with no runs", () => {
    expect(shouldReload([])).toBe(false);
  });
});

describe("the reload of the home page", () => {
  it("should reload every 5 seconds from the HTML when a run is running", async () => {
    const body = await pageOf([aRun(0, { result: "ready" }), aRun(1, { result: "running" })], () => "/");

    expect(body).toContain(RELOAD);
  });

  it("should not reload when no run is running", async () => {
    const body = await pageOf([aRun(0, { result: "ready" }), aRun(1, { result: "paused" })], () => "/");

    expect(body).not.toContain("http-equiv");
  });

  it("should not reload with no runs", async () => {
    const body = await pageOf([], () => "/");

    expect(body).not.toContain("http-equiv");
  });
});

describe("the reload of the page of a run", () => {
  it("should reload every 5 seconds from the HTML when the run is running", async () => {
    const body = await pageOf([aRun(0, { result: "running" })], firstRunPath);

    expect(body).toContain(RELOAD);
  });

  it.each(["ready", "draft", "paused"] as const)("should not reload when the run is %s", async (result) => {
    const body = await pageOf([aRun(0, { result })], firstRunPath);

    expect(body).not.toContain("http-equiv");
  });

  it("should not reload the page of a finished run because another run is running", async () => {
    const body = await pageOf([aRun(0, { result: "ready" }), aRun(1, { result: "running" })], firstRunPath);

    expect(body).not.toContain("http-equiv");
  });
});
