import { describe, expect, it } from "vitest";
import { defaultOrigin, MERGED_EARLIER, resumedLog } from "../../src/coordinator/resume.ts";
import { attemptRecord, runRecord, subtaskRecord } from "./run-log-fixtures.ts";

const NOW = new Date("2026-10-02T12:00:00.000Z");

const fresh = () =>
  runRecord(1, ["S1", "S2", "S3"].map((id) => subtaskRecord(id, { state: "pending" })), { result: "running" });

describe("resumedLog", () => {
  it("should keep a subtask blocked before the pause blocked, with its block, and continue the paused and interrupted ones", () => {
    const previous = runRecord(
      0,
      [
        subtaskRecord("S1", { state: "blocked", blockType: "scope", reason: "It needs x.", block: { type: "scope", reason: "It needs x." } }),
        subtaskRecord("S2", { state: "pending", carriedLoop: { firstAttempt: 0, elapsedMs: 5 } }),
        subtaskRecord("S3", { state: "interrupted", reason: "A failure of the worker layer stopped its gate." }),
      ],
      { result: "paused" },
    );

    const log = resumedLog({ fresh: fresh(), previous, merged: new Set(), now: NOW });

    expect(log.subtasks.map((record) => record.state)).toEqual(["blocked", "pending", "pending"]);
    expect(log.subtasks[0]).toMatchObject({ blockType: "scope", reason: "It needs x.", block: { type: "scope" } });
    expect(log.subtasks[1]?.carriedLoop).toEqual({ firstAttempt: 0, elapsedMs: 5 });
    expect(log.subtasks[2]).not.toHaveProperty("reason");
  });

  it("should not carry an attempt that never got its outcome into the continued run, because no process is working on it", () => {
    const unfinished = { ...attemptRecord("claude-code", 0, 0), number: 2, outcome: "running" as const };
    const previous = runRecord(
      0,
      [subtaskRecord("S1", { state: "pending", attempts: [{ ...attemptRecord("claude-code", 5, 5), number: 1 }, unfinished] })],
      { result: "paused" },
    );

    const log = resumedLog({ fresh: fresh(), previous, merged: new Set(), now: NOW });

    expect(log.subtasks[0]?.attempts.map((attempt) => [attempt.number, attempt.outcome])).toEqual([[1, "completed"]]);
  });

  it("should start every subtask that is not merged again on a new run, because only a paused run is continued", () => {
    const previous = runRecord(0, [subtaskRecord("S1", { state: "blocked", blockType: "patience" })], { result: "draft" });

    const log = resumedLog({ fresh: fresh(), previous, merged: new Set(["S2"]), now: NOW });

    expect(log.subtasks.map((record) => record.state)).toEqual(["pending", "merged", "pending"]);
    expect(log.subtasks[1]?.reason).toBe(MERGED_EARLIER);
  });
});

describe("resumedLog and the idle threshold of the run", () => {
  it("should keep the attemptIdleTimeoutMs the paused run recorded, although the new start carries another", () => {
    const previous = runRecord(0, [], { result: "paused", attemptIdleTimeoutMs: 1_800_000 });

    const log = resumedLog({ fresh: { ...fresh(), attemptIdleTimeoutMs: 60_000 }, previous, merged: new Set(), now: NOW });

    expect(log.attemptIdleTimeoutMs).toBe(1_800_000);
  });

  it("should take the attemptIdleTimeoutMs of the new start when the paused run is older than the field", () => {
    const previous = runRecord(0, [], { result: "paused" });

    const log = resumedLog({ fresh: { ...fresh(), attemptIdleTimeoutMs: 60_000 }, previous, merged: new Set(), now: NOW });

    expect(log.attemptIdleTimeoutMs).toBe(60_000);
  });

  it("should record the attemptIdleTimeoutMs of the new start on a run that does not continue a paused one", () => {
    const previous = runRecord(0, [], { result: "draft", attemptIdleTimeoutMs: 1_800_000 });

    const log = resumedLog({ fresh: { ...fresh(), attemptIdleTimeoutMs: 60_000 }, previous, merged: new Set(), now: NOW });

    expect(log.attemptIdleTimeoutMs).toBe(60_000);
  });
});

describe("defaultOrigin", () => {
  const paused = (agents: Partial<Record<"verifier" | "tester", { agent: "claude-code"; model: string }>>) => {
    const log = runRecord(0, [], { result: "paused" });
    return { ...log, agents: { workers: log.agents.workers, ...agents, changes: [] } };
  };

  it("should name the config when no run is paused", () => {
    expect(defaultOrigin(null, "workers")).toBe("config");
    expect(defaultOrigin(runRecord(0, [], { result: "draft" }), "workers")).toBe("config");
  });

  it("should name the paused run for the roles it recorded and the config for the role it did not", () => {
    const previous = paused({ verifier: { agent: "claude-code", model: "opus" } });

    expect(defaultOrigin(previous, "workers")).toBe("paused run");
    expect(defaultOrigin(previous, "verifier")).toBe("paused run");
    expect(defaultOrigin(previous, "tester")).toBe("config");
  });
});
