import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunsResponse } from "../../src/web/api.ts";
import { handleRequest } from "../../src/web/handler.ts";
import { subtaskRecord } from "../coordinator/run-log-fixtures.ts";
import { realLog, writeLiveRun } from "./live-fixtures.ts";
import { aRun, repoWithRuns, request, temp } from "./web-helpers.ts";

afterEach(() => temp.removeAll());

const MINUTE = 60_000;

async function runsOf(dir: string): Promise<RunsResponse> {
  return JSON.parse(String((await handleRequest(request(dir, "/api/runs"))).body)) as RunsResponse;
}

describe("the line of each run in the list of runs", () => {
  it("should give the first cause of a run that is not ready", async () => {
    const blocked = aRun(0, { result: "draft", subtasks: [subtaskRecord("health", { state: "blocked", blockType: "patience" }), subtaskRecord("ui", { state: "blocked", blockType: "scope" })] });

    expect((await runsOf(await repoWithRuns([{ log: blocked }]))).runs[0]?.line).toBe("Subtask health: blocked (patience)");
  });

  it("should give no line for a ready run, which needs nothing", async () => {
    expect((await runsOf(await repoWithRuns([{ log: aRun(0) }]))).runs[0]?.line).toBeNull();
  });

  it("should give the last event of a run in progress, read from the raw log of its agent", async () => {
    const lines = (await realLog("claude-activity.jsonl")).slice(0, 6);
    const dir = await temp.make("web-run-list-line-");
    await writeLiveRun(join(dir, ".factory", "logs"), { issue: 23, startedAgoMs: 5 * MINUTE, attempts: [{ subtask: "health", lines, silentMs: 20_000 }] });

    expect((await runsOf(dir)).runs[0]?.line).toBe("All checks pass. Next I'll commit.");
  });

  it("should give the current step of a run in progress whose agents have no event yet", async () => {
    const dir = await temp.make("web-run-list-line-");
    await writeLiveRun(join(dir, ".factory", "logs"), { issue: 23, startedAgoMs: MINUTE, attempts: [{ subtask: "health", lines: [], silentMs: 1000 }] });

    expect((await runsOf(dir)).runs[0]?.line).toBe("Subtareas · health");
  });
});
