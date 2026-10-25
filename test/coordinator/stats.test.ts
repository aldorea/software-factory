import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRunLogs } from "../../src/coordinator/run-history.ts";
import type { RunLog } from "../../src/coordinator/run-log.ts";
import { formatStats, summarizeRuns } from "../../src/coordinator/stats.ts";
import { temp } from "./harness.ts";
import { attemptRecord, cleanRun, failedRun, pausedRun, runRecord, subtaskRecord } from "./run-log-fixtures.ts";

afterEach(() => temp.removeAll());

function history(): RunLog[] {
  const ready = runRecord(
    0,
    [
      subtaskRecord("S1", { criteria: ["A1"], attempts: [attemptRecord("claude-code", 1000, 500)], gateRejections: 1 }),
      subtaskRecord("S2", {
        criteria: ["A2"],
        attempts: [attemptRecord("claude-code", 2000, 1000), attemptRecord("claude-code", 500, 500)],
        scopeExtensions: ["src/extra.ts"],
        conflicts: 1,
      }),
    ],
    { durationMs: 10 * 60_000, verification: { sha: "abc", passed: true, checks: [], criteria: [], humanCriteria: [] } },
  );
  const draft = runRecord(
    1,
    [
      subtaskRecord("S1", { criteria: ["A1"], attempts: [attemptRecord("claude-code", 3000, 1000)] }),
      subtaskRecord("S2", {
        criteria: ["A2"],
        state: "blocked",
        blockType: "patience",
        attempts: [attemptRecord("claude-code", 1000, 1000)],
        verifierRejections: 2,
      }),
    ],
    { result: "draft", durationMs: 20 * 60_000 },
  );
  const paused = { ...pausedRun(2, "opencode", "claude-code"), result: "paused" as const };
  const failed = failedRun(3, "opencode");
  return [ready, draft, paused, failed];
}

describe("the summary of the run logs of a repo", () => {
  it("should count the runs by result", () => {
    const stats = summarizeRuns(history());
    expect(stats.runs).toBe(4);
    expect(stats.results).toEqual({ ready: 2, draft: 1, paused: 1, running: 0 });
  });

  it("should add up the criteria that pass, the blocked ones and the human ones", () => {
    const stats = summarizeRuns(history());
    expect(stats.criteria).toEqual({ passing: 2, blocked: 1, human: 0, pending: 1 });
  });

  it("should add up the tokens and the attempts of every run, and the wall clock with no pauses", () => {
    const stats = summarizeRuns(history());
    expect(stats.cost.attempts).toBe(3 + 2 + 0 + 1);
    expect(stats.cost.countedTokens).toBe(5500 + 6000 + 0 + 150);
    expect(stats.cost.wallClockMs).toBe((10 + 20 + 1 + 1) * 60_000);
  });

  it("should average the tokens and the attempts per run and per subtask", () => {
    const stats = summarizeRuns(history());
    expect(stats.cost.perRun.attempts).toBeCloseTo(6 / 4);
    expect(stats.cost.perRun.countedTokens).toBeCloseTo(11_650 / 4);
    expect(stats.cost.perSubtask.count).toBe(6);
    expect(stats.cost.perSubtask.attempts).toBeCloseTo(1);
    expect(stats.cost.perSubtask.maxCountedTokens).toBe(4000);
  });

  it("should split runs, attempts, tokens and pauses per agent to compare the subscriptions", () => {
    const stats = summarizeRuns(history());
    expect(stats.perAgent["claude-code"]).toEqual({ runs: 3, attempts: 5, countedTokens: 11_500, pauses: 0 });
    expect(stats.perAgent.opencode).toEqual({ runs: 1, attempts: 1, countedTokens: 150, pauses: 1 });
  });

  it("should add the tokens of the verifier to its agent, apart from the attempts", () => {
    const usage = { inputTokens: 300, cacheCreationInputTokens: 20, cacheReadInputTokens: 5000, outputTokens: 80 };
    const run = runRecord(0, [
      subtaskRecord("S1", { attempts: [attemptRecord("claude-code", 1000, 500)], verifierUsage: { opencode: usage } }),
    ]);
    const stats = summarizeRuns([run]);
    expect(stats.perAgent["claude-code"]).toMatchObject({ attempts: 1, countedTokens: 1500 });
    expect(stats.perAgent.opencode).toMatchObject({ attempts: 0, countedTokens: 400 });
  });

  it("should add up the friction: blocks by type, scope extensions, rejections and conflicts", () => {
    const stats = summarizeRuns(history());
    expect(stats.friction.blocks.patience).toBe(1);
    expect(stats.friction.blocks.scope).toBe(0);
    expect(stats.friction.scopeExtensions).toBe(1);
    expect(stats.friction.gateRejections).toBe(1);
    expect(stats.friction.verifierRejections).toBe(2);
    expect(stats.friction.integrationConflicts).toBe(1);
  });

  it("should count the failures of the worker layer by kind", () => {
    const stats = summarizeRuns(history());
    expect(stats.workerLayerFailures).toEqual({ "container-start": 1 });
  });

  it("should summarize an empty history with zeros and no division by zero", () => {
    const stats = summarizeRuns([]);
    expect(stats.runs).toBe(0);
    expect(stats.cost.perRun).toEqual({ attempts: 0, countedTokens: 0, wallClockMs: 0 });
  });
});

describe("the printed summary", () => {
  it("should say there are no runs for a repo with none", () => {
    expect(formatStats(summarizeRuns([]))).toBe("No runs yet: .factory/logs has no run.json files.");
  });

  it("should print results, cost, friction and failures of a repo with several runs", () => {
    const text = formatStats(summarizeRuns(history()));
    expect(text).toContain("Runs: 4 (ready 2, draft 1, paused 1)");
    expect(text).toContain("Criteria: passing 2, blocked 1, human 0, pending 1");
    expect(text).toContain("Attempts: 6");
    expect(text).toContain("Wall clock without pauses: 32 min");
    expect(text).toContain("Blocks: patience 1");
    expect(text).toContain("Scope extensions: 1");
    expect(text).toContain("Gate rejections: 1");
    expect(text).toContain("Verifier rejections: 2");
    expect(text).toContain("Integration conflicts: 1");
    expect(text).toContain("Worker-layer failures: container-start 1");
    expect(text).toContain("claude-code: 3 runs, 5 attempts, 11500 tokens, 0 pauses");
    expect(text).toContain("opencode: 1 run, 1 attempt, 150 tokens, 1 pause");
  });

  it("should say there were no worker-layer failures when there were none", () => {
    expect(formatStats(summarizeRuns([cleanRun(0)]))).toContain("Worker-layer failures: none");
  });

  it("should tell how many run.json files could not be read", () => {
    const text = formatStats(summarizeRuns([cleanRun(0)]), ["1-bad/run.json"]);
    expect(text).toContain("Unreadable run.json files: 1-bad/run.json");
  });
});

describe("reading the run logs of a repo", () => {
  async function logsDir(files: Record<string, string>): Promise<string> {
    const dir = await temp.make("stats-logs-");
    for (const [name, text] of Object.entries(files)) {
      await mkdir(join(dir, name), { recursive: true });
      await writeFile(join(dir, name, "run.json"), text);
    }
    return dir;
  }

  it("should read every run.json ordered by start time", async () => {
    const [first, second] = [cleanRun(0), cleanRun(1)] as [RunLog, RunLog];
    const dir = await logsDir({
      [second.runId]: JSON.stringify(second),
      [first.runId]: JSON.stringify(first),
    });
    const { logs, unreadable } = await readRunLogs(dir);
    expect(logs.map((log) => log.runId)).toEqual([first.runId, second.runId]);
    expect(unreadable).toEqual([]);
  });

  it("should report a run.json that cannot be parsed and go on with the rest", async () => {
    const dir = await logsDir({ "1-run-00": JSON.stringify(cleanRun(0)), "1-broken": "{not json" });
    const { logs, unreadable } = await readRunLogs(dir);
    expect(logs).toHaveLength(1);
    expect(unreadable).toEqual(["1-broken/run.json"]);
  });

  it("should return no runs for a folder that does not exist", async () => {
    const dir = await temp.make("stats-none-");
    expect(await readRunLogs(join(dir, "missing"))).toEqual({ logs: [], unreadable: [] });
  });

  it("should skip a run folder with no run.json", async () => {
    const dir = await logsDir({});
    await mkdir(join(dir, "1-empty"));
    expect(await readRunLogs(dir)).toEqual({ logs: [], unreadable: [] });
  });
});
