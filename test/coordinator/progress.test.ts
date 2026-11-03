import { describe, expect, it } from "vitest";
import { progressLines } from "../../src/coordinator/progress.ts";
import type { RunLog } from "../../src/coordinator/run-log.ts";
import { attemptRecord, runRecord, subtaskRecord } from "./run-log-fixtures.ts";

const NO_APP = { checks: [{ name: "test", command: "pnpm test" }] };

const WITH_APP = {
  checks: [{ name: "install", command: "pnpm install" }],
  app: { start: "pnpm dev", ready: "curl -f localhost:4000", readyTimeoutMs: 60_000 },
};

function running(overrides: Partial<RunLog> = {}): RunLog {
  return runRecord(1, [subtaskRecord("S1", { state: "pending" }), subtaskRecord("S2", { state: "pending" })], {
    result: "running",
    ...overrides,
  });
}

describe("the progress lines of a run", () => {
  it("should announce the run, its subtasks and the workers at the first save", () => {
    expect(progressLines(null, running(), NO_APP)).toEqual(["run 1-run-01: 2 subtasks, workers on claude-code m"]);
  });

  it("should report nothing when a save changes nothing a developer watches", () => {
    expect(progressLines(running(), running(), NO_APP)).toEqual([]);
  });

  it("should report each subtask that changes state", () => {
    const after = running({ subtasks: [subtaskRecord("S1", { state: "working" }), subtaskRecord("S2", { state: "pending" })] });

    expect(progressLines(running(), after, NO_APP)).toEqual(["S1: working"]);
  });

  it("should report a finished attempt with the signature of its failure before the new state", () => {
    const failed = { ...attemptRecord("opencode", 1, 1), outcome: "agent-error" as const, failure: { signature: "agent-error: no output", description: "d" } };
    const before = running({ subtasks: [subtaskRecord("S1", { state: "working" }), subtaskRecord("S2", { state: "pending" })] });
    const after = running({
      subtasks: [subtaskRecord("S1", { state: "blocked", blockType: "patience", attempts: [failed] }), subtaskRecord("S2", { state: "pending" })],
    });

    expect(progressLines(before, after, NO_APP)).toEqual(["S1: attempt 1 agent-error: agent-error: no output", "S1: blocked (patience)"]);
  });

  it("should not report an attempt that is running, and report it once when it ends, so that the activity is not repeated by the progress", () => {
    const started = { ...attemptRecord("claude-code", 0, 0), outcome: "running" as const };
    const ended = attemptRecord("claude-code", 10, 5);
    const states = (attempts: (typeof started | typeof ended)[]) =>
      running({ subtasks: [subtaskRecord("S1", { state: "working", attempts }), subtaskRecord("S2", { state: "pending" })] });

    expect(progressLines(states([]), states([started]), NO_APP)).toEqual([]);
    expect(progressLines(states([started]), states([ended]), NO_APP)).toEqual(["S1: attempt 1 completed"]);
    expect(progressLines(states([ended]), states([ended]), NO_APP)).toEqual([]);
  });

  it("should report the integrated verification, the result and the pull request once each", () => {
    const after = running({
      result: "ready",
      verification: { sha: "0123456789abcdef", passed: true, checks: [], criteria: [], humanCriteria: [] },
      pullRequest: { number: 7, url: "https://github.com/o/r/pull/7", draft: false },
    });

    expect(progressLines(running(), after, NO_APP)).toEqual([
      "integrated verification at 0123456789ab: passed",
      "run 1-run-01: ready",
      "pull request: https://github.com/o/r/pull/7",
    ]);
    expect(progressLines(after, after, NO_APP)).toEqual([]);
  });

  it("should report the integrated verification only when the acceptance tester ends, because the tester can still fail a round whose checks passed", () => {
    const verification = { sha: "0123456789abcdef", passed: true, checks: [], criteria: [], humanCriteria: [] };
    const testing = running({ verification: { ...verification, testerPhase: "testing" } });
    const tested = running({ verification: { ...verification, passed: false } });

    expect(progressLines(running(), testing, NO_APP)).toEqual([]);
    expect(progressLines(testing, tested, NO_APP)).toEqual(["integrated verification at 0123456789ab: failed"]);
  });

  it("should report a pause with its reason", () => {
    expect(progressLines(running(), running({ result: "paused", pauseReason: "plan limit" }), NO_APP)).toEqual([
      "run paused: plan limit",
      "run 1-run-01: paused",
    ]);
  });

  it("should report each phase of the acceptance tester while it prepares the app, with the check and the commands of the config, and stay silent while it tests", () => {
    const verification = { sha: "0123456789abcdef", passed: true, checks: [], criteria: [], humanCriteria: [] };
    const phases = [undefined, "install", "start", "ready", "testing"] as const;
    const logs = phases.map((testerPhase) => running({ verification: { ...verification, ...(testerPhase ? { testerPhase } : {}) } }));

    const lines = logs.slice(1).flatMap((after, index) => progressLines(logs[index] ?? null, after, WITH_APP));

    expect(lines).toEqual([
      "tester: running the install check",
      "tester: starting the app with pnpm dev",
      "tester: waiting for the app to be ready (curl -f localhost:4000)",
    ]);
  });
});
