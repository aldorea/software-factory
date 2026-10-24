import { describe, expect, it } from "vitest";
import { adjustMaxParallel, type ParallelismBounds } from "../../src/coordinator/parallelism.ts";
import type { RunLog } from "../../src/coordinator/run-log.ts";
import { cleanRun, failedRun, pausedRun } from "./run-log-fixtures.ts";

const BOUNDS: ParallelismBounds = { start: 1, ceiling: 2 };

function clean(count: number, from = 0): RunLog[] {
  return Array.from({ length: count }, (_, index) => cleanRun(from + index));
}

describe("the maxParallel adjustment", () => {
  it("should start at the configured start value when there is no history", () => {
    expect(adjustMaxParallel([], "claude-code", BOUNDS)).toBe(1);
    expect(adjustMaxParallel([], "claude-code", { start: 2, ceiling: 2 })).toBe(2);
  });

  it("should stay at 1 after fewer than 3 runs in a row with no worker-layer failure", () => {
    expect(adjustMaxParallel(clean(2), "claude-code", BOUNDS)).toBe(1);
  });

  it("should go up by one after 3 runs in a row with no worker-layer failure", () => {
    expect(adjustMaxParallel(clean(3), "claude-code", BOUNDS)).toBe(2);
  });

  it("should never exceed the ceiling however many clean runs there are", () => {
    expect(adjustMaxParallel(clean(12), "claude-code", BOUNDS)).toBe(2);
  });

  it("should respect a lower ceiling set in the config", () => {
    expect(adjustMaxParallel(clean(6), "claude-code", { start: 1, ceiling: 1 })).toBe(1);
  });

  it("should restart the count of clean runs after a run with a worker-layer failure", () => {
    const history = [cleanRun(0), cleanRun(1), failedRun(2), cleanRun(3), cleanRun(4)];
    expect(adjustMaxParallel(history, "claude-code", BOUNDS)).toBe(1);
    expect(adjustMaxParallel([...history, cleanRun(5)], "claude-code", BOUNDS)).toBe(2);
  });

  it("should need 3 more clean runs after going up before it goes up again", () => {
    expect(adjustMaxParallel(clean(5), "claude-code", { start: 1, ceiling: 3 })).toBe(2);
    expect(adjustMaxParallel(clean(6), "claude-code", { start: 1, ceiling: 3 })).toBe(3);
  });

  it("should go down by one on a pause", () => {
    expect(adjustMaxParallel([...clean(3), pausedRun(3)], "claude-code", BOUNDS)).toBe(1);
  });

  it("should never go below 1", () => {
    expect(adjustMaxParallel([pausedRun(0), pausedRun(1)], "claude-code", BOUNDS)).toBe(1);
  });

  it("should count each pause of a run, not only the last one", () => {
    const stamp = pausedRun(3).pauses![0]!;
    const twice: RunLog = { ...pausedRun(3), result: "ready", pauses: [stamp, stamp] };
    expect(adjustMaxParallel([...clean(3), twice], "claude-code", { start: 2, ceiling: 3 })).toBe(1);
  });

  it("should not count a run that paused as one of the clean runs toward going up", () => {
    const history = [cleanRun(0), cleanRun(1), pausedRun(2), cleanRun(3), cleanRun(4)];
    expect(adjustMaxParallel(history, "claude-code", BOUNDS)).toBe(1);
  });

  it("should keep a pause that happened in a run that later finished", () => {
    const resumed: RunLog = { ...pausedRun(0), result: "ready" };
    expect(adjustMaxParallel([resumed], "claude-code", { start: 2, ceiling: 2 })).toBe(1);
  });

  it("should adjust each agent from its own runs", () => {
    const history = [...clean(3), cleanRun(3, "opencode")];
    expect(adjustMaxParallel(history, "claude-code", BOUNDS)).toBe(2);
    expect(adjustMaxParallel(history, "opencode", BOUNDS)).toBe(1);
  });

  it("should lower the agent whose plan limit paused the run even when the workers use another agent", () => {
    const history = [pausedRun(0, "opencode", "claude-code")];
    expect(adjustMaxParallel(history, "opencode", { start: 2, ceiling: 2 })).toBe(1);
    expect(adjustMaxParallel(history, "claude-code", { start: 2, ceiling: 2 })).toBe(2);
  });

  it("should ignore a run that did not finish and is not paused", () => {
    const crashed: RunLog = { ...cleanRun(2), result: "running" };
    expect(adjustMaxParallel([cleanRun(0), cleanRun(1), crashed], "claude-code", BOUNDS)).toBe(1);
  });

  it("should order the history by start time whatever order it is given in", () => {
    const history = [cleanRun(2), pausedRun(3), cleanRun(0), cleanRun(1)];
    expect(adjustMaxParallel(history, "claude-code", BOUNDS)).toBe(1);
    expect(adjustMaxParallel([...history].reverse(), "claude-code", BOUNDS)).toBe(1);
  });

  it("should not let a pause that came before the clean runs hold the value down", () => {
    const history = [pausedRun(0), cleanRun(1), cleanRun(2), cleanRun(3)];
    expect(adjustMaxParallel(history, "claude-code", { start: 1, ceiling: 2 })).toBe(2);
  });
});
