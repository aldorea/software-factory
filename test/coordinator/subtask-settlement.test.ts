import { describe, expect, it } from "vitest";
import type { SubtaskState } from "../../src/coordinator/run-log.ts";
import {
  applyMerge,
  applySettlement,
  blockSubtask,
  entryOf,
  INTERRUPTED_IN_ATTEMPT,
  INTERRUPTED_IN_GATE,
  notStartedReason,
  settleLoop,
  waveScopes,
} from "../../src/coordinator/subtask-settlement.ts";
import type { Subtask } from "../../src/spec/spec.ts";
import { subtaskRecord } from "./run-log-fixtures.ts";

const subtask = (id: string, dependsOn: string[] = [], scope: string[] = [`${id}/`]): Subtask => ({
  id,
  criteria: [],
  scope,
  dependsOn,
  testChanges: [],
});

describe("settleLoop", () => {
  it("should merge an accepted loop", () => {
    expect(settleLoop({ kind: "accepted", budget: { firstAttempt: 0, elapsedMs: 0 } })).toEqual({ kind: "merge" });
  });

  it("should interrupt a loop the worker layer stopped, saying whether it stopped the attempt or the gate", () => {
    expect(settleLoop(null)).toEqual({ kind: "interrupted", reason: INTERRUPTED_IN_ATTEMPT });
    expect(settleLoop({ kind: "interrupted" })).toEqual({ kind: "interrupted", reason: INTERRUPTED_IN_GATE });
  });

  it("should block a loop that stopped, keeping its last failure", () => {
    expect(
      settleLoop({ kind: "blocked", stop: { type: "patience", reason: "3 in a row" }, lastFailure: "check failed" }),
    ).toEqual({ kind: "blocked", block: { type: "patience", reason: "3 in a row", lastFailure: "check failed" } });
  });

  it("should block a loop whose worker reported a design question", () => {
    expect(settleLoop({ kind: "reported", type: "design-question", reason: "which colour?" })).toEqual({
      kind: "blocked",
      block: { type: "design-question", reason: "which colour?" },
    });
  });

  it("should pause with the plan limit that paused the loop", () => {
    const limit = { kind: "plan-limit" as const, agent: "claude-code" as const, message: "limit" };
    expect(settleLoop({ kind: "paused", limit })).toEqual({ kind: "paused", limit });
    expect(settleLoop({ kind: "paused" })).toEqual({ kind: "paused" });
  });
});

describe("applySettlement", () => {
  it("should mark an interrupted subtask with its reason", () => {
    const record = subtaskRecord("S1", { state: "working" });
    expect(applySettlement(record, { kind: "interrupted", reason: "why" }, false)).toBe("interrupted");
    expect(record).toMatchObject({ state: "interrupted", reason: "why" });
  });

  it("should block a subtask with the type of block that the stop maps to", () => {
    const record = subtaskRecord("S1", { state: "working" });
    expect(applySettlement(record, { kind: "blocked", block: { type: "run-tokens", reason: "too many" } }, false)).toBe(
      "blocked",
    );
    expect(record).toMatchObject({ state: "blocked", blockType: "limit", reason: "too many", block: { type: "run-tokens" } });
  });

  it("should leave a paused follow-up merged, because its earlier work already merged", () => {
    const followUp = subtaskRecord("S1", { state: "pending" });
    const first = subtaskRecord("S2", { state: "pending" });
    expect(applySettlement(followUp, { kind: "paused" }, true)).toBe("paused");
    expect(applySettlement(first, { kind: "paused" }, false)).toBe("paused");
    expect(followUp.state).toBe("merged");
    expect(first.state).toBe("pending");
  });
});

describe("applyMerge", () => {
  it("should mark a merged subtask merged", () => {
    const record = subtaskRecord("S1", { state: "gating" });
    expect(applyMerge(record, { kind: "merged" }, "factory/1-x")).toBe("merged");
    expect(record.state).toBe("merged");
  });

  it("should block a conflicting merge with its files and count the conflict", () => {
    const record = subtaskRecord("S1", { state: "gating" });
    expect(applyMerge(record, { kind: "conflict", files: ["a.ts", "b.ts"] }, "factory/1-x")).toBe("blocked");
    expect(record).toMatchObject({
      state: "blocked",
      conflicts: 1,
      conflictFiles: ["a.ts", "b.ts"],
      reason: "Its merge into factory/1-x conflicts in a.ts, b.ts.",
    });
  });
});

describe("blockSubtask", () => {
  it("should keep scope, design-question and patience as their own block types and count every hard limit as a limit", () => {
    const types = (["scope", "design-question", "patience", "subtask-wall-clock", "run-tokens"] as const).map((type) => {
      const record = subtaskRecord("S1");
      blockSubtask(record, { type, reason: "r" });
      return record.blockType;
    });
    expect(types).toEqual(["scope", "design-question", "patience", "limit", "limit"]);
  });
});

describe("notStartedReason", () => {
  const states = (entries: Record<string, SubtaskState>) => new Map(Object.entries(entries));

  it("should not start a subtask while the base subtask is not merged", () => {
    expect(
      notStartedReason({ subtask: subtask("S1"), baseId: "B", states: states({ B: "blocked" }), conflicted: false }),
    ).toBe("It did not start because the base subtask B is blocked.");
  });

  it("should not hold back the base subtask itself", () => {
    expect(notStartedReason({ subtask: subtask("B"), baseId: "B", states: states({ B: "pending" }), conflicted: false })).toBeNull();
  });

  it("should not start a subtask after a merge conflict, because a conflict is an error of the refinement", () => {
    expect(notStartedReason({ subtask: subtask("S1"), baseId: null, states: states({}), conflicted: true })).toBe(
      "It did not start because the run stopped on a merge conflict.",
    );
  });

  it("should not start a subtask whose dependency is blocked", () => {
    expect(
      notStartedReason({ subtask: subtask("S2", ["S1"]), baseId: null, states: states({ S1: "blocked" }), conflicted: false }),
    ).toBe("It depends on S1, which is blocked.");
  });
});

describe("waveScopes", () => {
  it("should give the live scopes of the other subtasks of the same wave only", () => {
    const plan = { base: null, waves: [[subtask("S1"), subtask("S2")], [subtask("S3")]] };
    const scopes = new Map([
      ["S1", ["a/"]],
      ["S2", ["b/", "extra/"]],
      ["S3", ["c/"]],
    ]);
    expect(waveScopes(plan, "S1", scopes)).toEqual([{ subtask: "S2", scope: ["b/", "extra/"] }]);
    expect(waveScopes(plan, "S3", scopes)).toEqual([]);
  });

  it("should fail closed when a subtask of the wave has no scope, instead of treating it as owning nothing", () => {
    const plan = { base: null, waves: [[subtask("S1"), subtask("S2")]] };
    expect(() => waveScopes(plan, "S1", new Map([["S1", ["a/"]]]))).toThrow("the run has no scope of subtask S2");
  });
});

describe("entryOf", () => {
  it("should fail closed on a subtask the run does not know", () => {
    expect(() => entryOf(new Map<string, number>(), "S9", "record")).toThrow("the run has no record of subtask S9");
  });
});
