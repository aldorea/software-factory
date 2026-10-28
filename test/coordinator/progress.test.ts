import { describe, expect, it } from "vitest";
import { progressLines } from "../../src/coordinator/progress.ts";
import type { RunLog } from "../../src/coordinator/run-log.ts";
import { attemptRecord, runRecord, subtaskRecord } from "./run-log-fixtures.ts";

function running(overrides: Partial<RunLog> = {}): RunLog {
  return runRecord(1, [subtaskRecord("S1", { state: "pending" }), subtaskRecord("S2", { state: "pending" })], {
    result: "running",
    ...overrides,
  });
}

describe("the progress lines of a run", () => {
  it("should announce the run, its subtasks and the workers at the first save", () => {
    expect(progressLines(null, running())).toEqual(["run 1-run-01: 2 subtasks, workers on claude-code m"]);
  });

  it("should report nothing when a save changes nothing a developer watches", () => {
    expect(progressLines(running(), running())).toEqual([]);
  });

  it("should report each subtask that changes state", () => {
    const after = running({ subtasks: [subtaskRecord("S1", { state: "working" }), subtaskRecord("S2", { state: "pending" })] });

    expect(progressLines(running(), after)).toEqual(["S1: working"]);
  });

  it("should report a finished attempt with the signature of its failure before the new state", () => {
    const failed = { ...attemptRecord("opencode", 1, 1), outcome: "agent-error" as const, failure: { signature: "agent-error: no output", description: "d" } };
    const before = running({ subtasks: [subtaskRecord("S1", { state: "working" }), subtaskRecord("S2", { state: "pending" })] });
    const after = running({
      subtasks: [subtaskRecord("S1", { state: "blocked", blockType: "patience", attempts: [failed] }), subtaskRecord("S2", { state: "pending" })],
    });

    expect(progressLines(before, after)).toEqual(["S1: attempt 1 agent-error: agent-error: no output", "S1: blocked (patience)"]);
  });

  it("should report the integrated verification, the result and the pull request once each", () => {
    const after = running({
      result: "ready",
      verification: { sha: "0123456789abcdef", passed: true, checks: [], criteria: [], humanCriteria: [] },
      pullRequest: { number: 7, url: "https://github.com/o/r/pull/7", draft: false },
    });

    expect(progressLines(running(), after)).toEqual([
      "integrated verification at 0123456789ab: passed",
      "run 1-run-01: ready",
      "pull request: https://github.com/o/r/pull/7",
    ]);
    expect(progressLines(after, after)).toEqual([]);
  });

  it("should report a pause with its reason", () => {
    expect(progressLines(running(), running({ result: "paused", pauseReason: "plan limit" }))).toEqual([
      "run paused: plan limit",
      "run 1-run-01: paused",
    ]);
  });
});
