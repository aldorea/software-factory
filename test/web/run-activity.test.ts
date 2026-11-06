import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LiveResponse } from "../../src/web/live.ts";
import { handleRequest } from "../../src/web/handler.ts";
import { realLog, writeLiveRun, type LiveRunFixture } from "./live-fixtures.ts";
import { NOW, request, temp } from "./web-helpers.ts";

afterEach(() => temp.removeAll());

const MINUTE = 60_000;

async function repoWith(...runs: LiveRunFixture[]): Promise<{ dir: string; runIds: string[] }> {
  const dir = await temp.make("web-run-activity-");
  const runIds: string[] = [];
  for (const run of runs) runIds.push((await writeLiveRun(join(dir, ".factory", "logs"), run)).runId);
  return { dir, runIds };
}

async function activityOf(dir: string, runId: string): Promise<LiveResponse> {
  const response = await handleRequest(request(dir, `/api/runs/${runId}/activity`));
  expect(response.status).toBe(200);
  expect(response.contentType).toBe("application/json; charset=utf-8");
  return JSON.parse(response.body) as LiveResponse;
}

describe("the activity of a run in the API", () => {
  it("should give only the agents of that run, never those of another run in progress", async () => {
    const lines = (await realLog("claude-activity.jsonl")).slice(0, 6);
    const { dir, runIds } = await repoWith(
      { issue: 23, startedAgoMs: 30 * MINUTE, attempts: [{ subtask: "health", lines }] },
      { issue: 24, startedAgoMs: 20 * MINUTE, attempts: [{ subtask: "auth", lines }] },
    );
    const runId = runIds[0] as string;

    const activity = await activityOf(dir, runId);

    expect(activity.now).toBe(NOW.toISOString());
    expect(activity.inProgress).toBe(true);
    expect(activity.atWork).toBe(1);
    expect(activity.runs.map((run) => run.runId)).toEqual([runId]);
    expect(activity.runs[0]?.agents.map((agent) => [agent.id, agent.state, agent.lastMessage])).toEqual([
      [`${runId}:worker:health:1`, "working", "All checks pass. Next I'll commit."],
    ]);
  });

  it("should give the ended agents of a run that ended, which Live no longer lists, and ask for no refresh", async () => {
    const { dir, runIds } = await repoWith({
      issue: 23,
      result: "ready",
      attempts: [
        { subtask: "health", number: 1, outcome: "agent-error", durationMs: 2 * MINUTE, usage: { inputTokens: 1200, outputTokens: 300 } },
        { subtask: "health", number: 2, outcome: "completed", durationMs: 3 * MINUTE, usage: { inputTokens: 900, outputTokens: 250 } },
      ],
    });
    const runId = runIds[0] as string;

    const activity = await activityOf(dir, runId);

    expect(activity.inProgress).toBe(false);
    expect(activity.atWork).toBe(0);
    expect(activity.runs[0]?.agents.map((agent) => [agent.id, agent.state, agent.outcome, agent.elapsedMs, agent.tokens])).toEqual([
      [`${runId}:worker:health:1`, "ended", "agent-error", 2 * MINUTE, { input: 1200, output: 300 }],
      [`${runId}:worker:health:2`, "ended", "completed", 3 * MINUTE, { input: 900, output: 250 }],
    ]);
    const live = JSON.parse((await handleRequest(request(dir, "/api/live"))).body) as LiveResponse;
    expect(live.runs).toEqual([]);
  });

  it("should answer a run that does not exist with a JSON 404", async () => {
    const { dir } = await repoWith();

    const response = await handleRequest(request(dir, "/api/runs/23-2026-10-24T07-00-00-000Z/activity"));

    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ error: "not found" });
  });
});
