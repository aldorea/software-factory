import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunsResponse } from "../../src/web/api.ts";
import { handleRequest } from "../../src/web/handler.ts";
import { writeRunningRun, type RunningRun } from "../coordinator/running-run.ts";
import type { RunDetail } from "../../src/web/run-detail.ts";
import { NOW, request, runDetailIn, temp } from "./web-helpers.ts";

afterEach(() => temp.removeAll());

const TIMEOUT = 10 * 60_000;

function before(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

async function repoWith(
  runJsonSilentMs: number,
  logSilentMs: number,
  attemptIdleTimeoutMs?: number,
): Promise<{ dir: string; run: RunningRun }> {
  const dir = await temp.make("web-abandoned-");
  const run = await writeRunningRun({
    logsDir: join(dir, ".factory", "logs"),
    runJsonAt: before(runJsonSilentMs),
    logAt: before(logSilentMs),
    ...(attemptIdleTimeoutMs !== undefined ? { attemptIdleTimeoutMs } : {}),
  });
  return { dir, run };
}

async function runsOf(dir: string): Promise<RunsResponse> {
  const response = await handleRequest(request(dir, "/api/runs"));
  expect(response.status).toBe(200);
  return JSON.parse(String(response.body)) as RunsResponse;
}

async function statuses(dir: string): Promise<string[]> {
  return (await runsOf(dir)).runs.map((row) => row.status);
}

async function runOf(dir: string, run: RunningRun): Promise<RunDetail> {
  return runDetailIn(dir, run.runId);
}

describe("an abandoned run in factory web", () => {
  it("should give abandoned and not running in the list of runs", async () => {
    const { dir } = await repoWith(TIMEOUT + 60_000, TIMEOUT + 60_000);

    expect(await statuses(dir)).toEqual(["abandoned"]);
  });

  it("should count it apart from the running and the finished runs in the statistics", async () => {
    const { dir } = await repoWith(TIMEOUT + 60_000, TIMEOUT + 60_000);

    const { stats } = await runsOf(dir);

    expect(stats?.results.abandoned).toBe(1);
    expect(stats?.results.running).toBe(0);
  });

  it("should give abandoned and not running in the run of the API, and in its attempt in progress", async () => {
    const { dir, run } = await repoWith(TIMEOUT + 60_000, TIMEOUT + 60_000);

    const detail = await runOf(dir, run);

    expect(detail.status).toBe("abandoned");
    expect(detail.subtasks.flatMap((subtask) => subtask.attempts.map((attempt) => attempt.outcome))).toEqual(["abandoned"]);
  });

  it("should not ask again for the list nor reload the page of the run, which no process is changing", async () => {
    const { dir, run } = await repoWith(TIMEOUT + 60_000, TIMEOUT + 60_000);

    expect((await runsOf(dir)).inProgress).toBe(false);
    expect((await runOf(dir, run)).inProgress).toBe(false);
  });
});

describe("a run in progress in factory web", () => {
  it("should show running while the raw log of its attempt keeps growing although run.json did not change", async () => {
    const { dir, run } = await repoWith(2 * 60 * 60_000, 30_000);

    const detail = await runOf(dir, run);

    expect(await statuses(dir)).toEqual(["running"]);
    expect(detail.status).toBe("running");
    expect(detail.subtasks.flatMap((subtask) => subtask.attempts.map((attempt) => attempt.outcome))).toEqual(["running"]);
    expect(detail.inProgress).toBe(true);
  });

  it("should take attemptIdleTimeoutMs from the run log so a longer limit keeps the run in progress", async () => {
    const { dir, run } = await repoWith(TIMEOUT + 60_000, TIMEOUT + 60_000, 2 * TIMEOUT);

    expect(await statuses(dir)).toEqual(["running"]);
    expect((await runOf(dir, run)).status).toBe("running");
  });

  it("should use the 10 minute default for a run log without attemptIdleTimeoutMs, as the runs of older versions", async () => {
    const { dir } = await repoWith(TIMEOUT + 60_000, TIMEOUT + 60_000);

    expect(await statuses(dir)).toEqual(["abandoned"]);
  });
});
