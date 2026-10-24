import { describe, expect, it } from "vitest";
import { MERGED_EARLIER, resumedLog } from "../../src/coordinator/resume.ts";
import { runRecord, subtaskRecord } from "./run-log-fixtures.ts";

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

  it("should start every subtask that is not merged again on a new run, because only a paused run is continued", () => {
    const previous = runRecord(0, [subtaskRecord("S1", { state: "blocked", blockType: "patience" })], { result: "draft" });

    const log = resumedLog({ fresh: fresh(), previous, merged: new Set(["S2"]), now: NOW });

    expect(log.subtasks.map((record) => record.state)).toEqual(["pending", "merged", "pending"]);
    expect(log.subtasks[1]?.reason).toBe(MERGED_EARLIER);
  });
});
