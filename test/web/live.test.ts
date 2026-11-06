import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AttemptRecord, RunLog } from "../../src/coordinator/run-log.ts";
import type { LiveResponse } from "../../src/web/live.ts";
import { RAW_LOG_TAIL_BYTES } from "../../src/web/live-read.ts";
import { handleRequest } from "../../src/web/handler.ts";
import { realLog, writeLiveRun, type LiveRunFixture } from "./live-fixtures.ts";
import { NOW, request, temp } from "./web-helpers.ts";

afterEach(() => temp.removeAll());

const MINUTE = 60_000;

async function repoWith(...runs: LiveRunFixture[]): Promise<{ dir: string; runIds: string[] }> {
  const dir = await temp.make("web-live-");
  const runIds: string[] = [];
  for (const run of runs) runIds.push((await writeLiveRun(join(dir, ".factory", "logs"), run)).runId);
  return { dir, runIds };
}

async function liveOf(dir: string): Promise<LiveResponse> {
  const response = await handleRequest(request(dir, "/api/live"));
  expect(response.status).toBe(200);
  expect(response.contentType).toBe("application/json; charset=utf-8");
  return JSON.parse(response.body) as LiveResponse;
}

describe("the live agents of the API", () => {
  it("should give each worker in progress as a card with its activity, read from its raw log through the adapter of its agent", async () => {
    const lines = (await realLog("claude-activity.jsonl")).slice(0, 6);
    const { dir, runIds } = await repoWith({
      issue: 23,
      attempts: [{ subtask: "health", agent: "claude-code", model: "claude-sonnet-5-5", lines, startedAgoMs: 5 * MINUTE, silentMs: 20_000 }],
    });
    const runId = runIds[0] as string;

    const live = await liveOf(dir);

    expect(live.now).toBe(NOW.toISOString());
    expect(live.inProgress).toBe(true);
    expect(live.atWork).toBe(1);
    expect(live.runs.map((run) => [run.runId, run.issue, run.title])).toEqual([[runId, 23, "health endpoint"]]);
    expect(live.runs[0]?.agents).toEqual([
      {
        id: `${runId}:worker:health:1`,
        runId,
        issue: 23,
        role: "worker",
        agent: "claude-code",
        model: "claude-sonnet-5-5",
        subtask: "health",
        criterion: null,
        attempt: 1,
        step: "working",
        lastTool: "Bash git status --short && find apps/nextjs/src/app/api/health -type f | xargs tail -n +1 && cat apps/ne…",
        lastMessage: "All checks pass. Next I'll commit.",
        events: [
          {
            at: "2026-10-27T07:26:01.312Z",
            kind: "tool",
            text: "Bash git status --short && find apps/nextjs/src/app/api/health -type f | xargs tail -n +1 && cat apps/ne…",
          },
          {
            at: "2026-10-27T07:26:02.877Z",
            kind: "message",
            text: "The files already exist. Next I'll check whether the middleware or auth blocks the route, then run …",
          },
          { at: "2026-10-27T07:27:44.315Z", kind: "message", text: "All checks pass. Next I'll commit." },
        ],
        startedAt: new Date(NOW.getTime() - 5 * MINUTE).toISOString(),
        elapsedMs: 5 * MINUTE,
        silentMs: 20_000,
        abandonAfterMs: 10 * MINUTE,
        state: "working",
        outcome: null,
        tokens: null,
      },
    ]);
  });

  it("should call a worker silent after a minute with no change of its raw log, and give the time left before abandonment", async () => {
    const lines = (await realLog("claude-activity.jsonl")).slice(0, 6);
    const { dir } = await repoWith({ attempts: [{ subtask: "health", lines, silentMs: 4 * MINUTE }] });

    const agent = (await liveOf(dir)).runs[0]?.agents[0];

    expect([agent?.state, agent?.silentMs, agent?.abandonAfterMs]).toEqual(["silent", 4 * MINUTE, 10 * MINUTE]);
  });

  it("should call abandoned a worker whose raw log has not changed for longer than the attemptIdleTimeoutMs of its run, while another keeps the run alive", async () => {
    const lines = (await realLog("claude-activity.jsonl")).slice(0, 6);
    const { dir } = await repoWith({
      attemptIdleTimeoutMs: 3 * MINUTE,
      attempts: [
        { subtask: "health", lines, silentMs: 3 * MINUTE + 1 },
        { subtask: "ui", lines, silentMs: 10_000 },
      ],
    });

    const live = await liveOf(dir);

    expect(live.runs[0]?.agents.map((agent) => [agent.subtask, agent.state, agent.abandonAfterMs])).toEqual([
      ["health", "abandoned", 3 * MINUTE],
      ["ui", "working", 3 * MINUTE],
    ]);
    expect(live.atWork).toBe(1);
  });

  it("should use the 10 minute default for a run log without attemptIdleTimeoutMs, as the runs of older versions", async () => {
    const lines = (await realLog("claude-activity.jsonl")).slice(0, 6);
    const { dir } = await repoWith({
      attempts: [
        { subtask: "health", lines, silentMs: 10 * MINUTE + 1 },
        { subtask: "ui", lines, silentMs: 10 * MINUTE },
      ],
    });

    const agents = (await liveOf(dir)).runs[0]?.agents ?? [];

    expect(agents.map((agent) => agent.state)).toEqual(["abandoned", "silent"]);
  });

  it("should give no tokens for an attempt of OpenCode in progress, which reports them only when it ends (#66), and read its events with its own adapter", async () => {
    const lines = await realLog("opencode-tools.jsonl");
    const { dir } = await repoWith({ attempts: [{ subtask: "deleted-option", agent: "opencode", model: "opencode-go/glm-5.1", lines }] });

    const agent = (await liveOf(dir)).runs[0]?.agents[0];

    expect(agent?.tokens).toBeNull();
    expect(agent?.lastTool).toBe("edit /Users/sito/Documents/askwell/.factory/worktrees/27-deleted-option/packages/forms/src/csv.ts");
    expect(agent?.lastMessage).toBe("Now I understand the codebase. Let me implement the changes in `csv.ts`:");
    expect(agent?.events.map((event) => [event.at, event.kind])).toEqual([
      ["2026-10-28T09:09:17.584Z", "tool"],
      ["2026-10-28T09:09:31.415Z", "tool"],
      ["2026-10-28T09:09:56.007Z", "tool"],
      ["2026-10-28T09:11:10.818Z", "message"],
      ["2026-10-28T09:11:10.872Z", "tool"],
    ]);
  });

  it("should fold a worker that ended into its outcome, its time and its tokens, and stop asking when no agent works", async () => {
    const { dir } = await repoWith({
      attempts: [
        { subtask: "health", number: 1, agent: "opencode", outcome: "agent-error", durationMs: 2 * MINUTE, usage: { inputTokens: 900, cacheCreationInputTokens: 100, cacheReadInputTokens: 5000, outputTokens: 40 } },
      ],
    });

    const live = await liveOf(dir);
    const agent = live.runs[0]?.agents[0];

    expect(agent).toMatchObject({ state: "ended", outcome: "agent-error", elapsedMs: 2 * MINUTE, silentMs: 0, tokens: { input: 1000, output: 40 }, events: [] });
    expect(live.inProgress).toBe(false);
    expect(live.atWork).toBe(0);
  });

  it("should list only the runs in progress, the most recent first, and leave out a run abandoned as a whole", async () => {
    const lines = (await realLog("claude-activity.jsonl")).slice(0, 6);
    const { dir, runIds } = await repoWith(
      { issue: 21, startedAgoMs: 60 * MINUTE, attempts: [{ subtask: "a", lines, silentMs: 0 }] },
      { issue: 22, startedAgoMs: 50 * MINUTE, result: "ready", attempts: [{ subtask: "b", outcome: "completed" }] },
      { issue: 23, startedAgoMs: 40 * MINUTE, runJsonSilentMs: 11 * MINUTE, attempts: [{ subtask: "c", lines, silentMs: 11 * MINUTE }] },
      { issue: 24, startedAgoMs: 30 * MINUTE, attempts: [{ subtask: "d", lines, silentMs: 0 }] },
    );

    expect((await liveOf(dir)).runs.map((run) => run.runId)).toEqual([runIds[3], runIds[0]]);
  });

  it("should answer an empty list with nothing in progress for a repo without a run log", async () => {
    const dir = await temp.make("web-live-empty-");

    expect(await liveOf(dir)).toEqual({ now: NOW.toISOString(), inProgress: false, atWork: 0, runs: [] });
  });

  it("should read only the end of a raw log in progress", async () => {
    const real = await realLog("claude-activity.jsonl");
    const [, tool, rateLimit = "", , first, second] = real as [string, string, string, string, string, string];
    const padding = Array.from({ length: Math.ceil((RAW_LOG_TAIL_BYTES * 2) / rateLimit.length) }, () => rateLimit);
    const { dir } = await repoWith({ attempts: [{ subtask: "health", lines: [first, ...padding, tool, second] }] });

    const agent = (await liveOf(dir)).runs[0]?.agents[0];

    expect(agent?.events.map((event) => event.kind)).toEqual(["tool", "message"]);
    expect(agent?.lastMessage).toBe("All checks pass. Next I'll commit.");
  });

  it("should keep only the last 20 events of an attempt", async () => {
    const real = await realLog("opencode-tools.jsonl");
    const lines = Array.from({ length: 6 }, () => real).flat();
    const { dir } = await repoWith({ attempts: [{ subtask: "deleted-option", agent: "opencode", lines }] });

    const events = (await liveOf(dir)).runs[0]?.agents[0]?.events ?? [];

    expect(events).toHaveLength(20);
    expect(events.at(-1)?.text).toBe("edit /Users/sito/Documents/askwell/.factory/worktrees/27-deleted-option/packages/forms/src/csv.ts");
  });

  it("should read no raw log outside the folder of its run", async () => {
    const outside = await temp.make("web-live-outside-");
    const { dir, runIds } = await repoWith({ attempts: [{ subtask: "health" }] });
    const runJson = join(dir, ".factory", "logs", runIds[0] as string, "run.json");
    const leaked = join(outside, "secret.jsonl");
    await writeFile(leaked, `${(await realLog("claude-activity.jsonl"))[5]}\n`);
    const log = JSON.parse(await readFile(runJson, "utf8")) as RunLog;
    (log.subtasks[0]?.attempts[0] as AttemptRecord).logPath = leaked;
    await writeFile(runJson, JSON.stringify(log));

    const agent = (await liveOf(dir)).runs[0]?.agents[0];

    expect(agent?.events).toEqual([]);
    expect(agent?.lastMessage).toBeNull();
  });
});

