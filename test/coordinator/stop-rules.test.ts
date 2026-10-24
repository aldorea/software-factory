import { describe, expect, it } from "vitest";
import { countedTokens, stopReason, type StopInput, type StopLimits } from "../../src/coordinator/stop-rules.ts";

const HOUR = 60 * 60 * 1000;

const LIMITS: StopLimits = {
  patience: 3,
  subtaskWallClockMs: 2 * HOUR,
  subtaskTokens: 2_000_000,
  runWallClockMs: 6 * HOUR,
  runTokens: 8_000_000,
};

function input(overrides: Partial<StopInput> = {}): StopInput {
  return { signatures: [], subtaskElapsedMs: 0, subtaskTokens: 0, runElapsedMs: 0, runTokens: 0, ...overrides };
}

describe("stopReason", () => {
  it("should not stop a subtask that is within every limit", () => {
    expect(stopReason(input({ signatures: ["a", "b"], subtaskElapsedMs: HOUR, subtaskTokens: 1_000_000 }), LIMITS)).toBeNull();
  });

  it("should stop by patience when the last 3 attempts failed with the same signature", () => {
    const stop = stopReason(input({ signatures: ["a", "b", "b", "b"] }), LIMITS);

    expect(stop?.type).toBe("patience");
    expect(stop?.reason).toContain("3 attempts in a row");
    expect(stop?.reason).toContain("b");
  });

  it("should reset the count of patience when a different signature comes in between", () => {
    expect(stopReason(input({ signatures: ["b", "b", "c", "b", "b"] }), LIMITS)).toBeNull();
  });

  it("should take the patience of the config, not a fixed 3", () => {
    expect(stopReason(input({ signatures: ["a", "a"] }), { ...LIMITS, patience: 2 })?.type).toBe("patience");
    expect(stopReason(input({ signatures: ["a", "a", "a"] }), { ...LIMITS, patience: 4 })).toBeNull();
  });

  it("should stop a subtask that reached its wall clock, with its own type and limit in the reason", () => {
    const stop = stopReason(input({ subtaskElapsedMs: 2 * HOUR }), LIMITS);

    expect(stop?.type).toBe("subtask-wall-clock");
    expect(stop?.reason).toContain("2 h");
  });

  it("should stop a subtask that reached its token limit, with its own type", () => {
    const stop = stopReason(input({ subtaskTokens: 2_000_000 }), LIMITS);

    expect(stop?.type).toBe("subtask-tokens");
    expect(stop?.reason).toContain("2,000,000");
  });

  it("should stop a run that reached its wall clock, with its own type", () => {
    expect(stopReason(input({ runElapsedMs: 6 * HOUR }), LIMITS)?.type).toBe("run-wall-clock");
  });

  it("should stop a run that reached its token limit, with its own type", () => {
    expect(stopReason(input({ runTokens: 8_000_000 }), LIMITS)?.type).toBe("run-tokens");
  });

  it("should apply the limits it is given, so an override of the config takes effect", () => {
    expect(stopReason(input({ subtaskTokens: 600 }), { ...LIMITS, subtaskTokens: 500 })?.type).toBe("subtask-tokens");
    expect(stopReason(input({ subtaskElapsedMs: 31 * 60_000 }), { ...LIMITS, subtaskWallClockMs: 30 * 60_000 })?.type).toBe(
      "subtask-wall-clock",
    );
  });

  it("should name a run limit before a subtask limit when both are reached", () => {
    expect(stopReason(input({ runElapsedMs: 7 * HOUR, subtaskElapsedMs: 3 * HOUR }), LIMITS)?.type).toBe("run-wall-clock");
  });
});

describe("countedTokens", () => {
  it("should count input without cache, cache creation and output, and leave cache reads out", () => {
    expect(
      countedTokens({ inputTokens: 100, cacheCreationInputTokens: 20, cacheReadInputTokens: 5_000, outputTokens: 3 }),
    ).toBe(123);
  });
});
