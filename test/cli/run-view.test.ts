import { describe, expect, it } from "vitest";
import { RunView } from "../../src/cli/run-view.ts";
import { CLEAR_LINE } from "../../src/cli/terminal-render.ts";
import type { AttemptRecord } from "../../src/coordinator/run-log.ts";
import { attemptRecord, runRecord, subtaskRecord } from "../coordinator/run-log-fixtures.ts";

const ESC = String.fromCharCode(27);
const ansi = /\u001b\[[0-9;]*[A-Za-z]/g;

function view(columns = 120) {
  const writes: string[] = [];
  let now = new Date(2026, 9, 28, 10, 0, 0);
  const instance = new RunView({ now: () => now, write: (text) => writes.push(text), columns: () => columns });
  return {
    view: instance,
    writes,
    at(h: number, m: number, s: number) {
      now = new Date(2026, 9, 28, h, m, s);
    },
  };
}

const running = (id: string, number: number, startedAt: Date): ReturnType<typeof subtaskRecord> =>
  subtaskRecord(id, {
    state: "working",
    attempts: [{ ...attemptRecord("claude-code", 0, 0), number, outcome: "running", startedAt: startedAt.toISOString() }],
  });

const withOutcome = (outcome: AttemptRecord["outcome"]) =>
  subtaskRecord("S1", { attempts: [{ ...attemptRecord("claude-code", 0, 0), number: 1, outcome }] });

describe("run view", () => {
  it("should write a progress line on its own line, with no bottom line while no attempt is in progress", () => {
    const { view: v, writes } = view();

    v.progress("S1: merged");

    expect(writes.join("")).toBe(`${CLEAR_LINE}${ESC}[2m10:00:00 ${ESC}[0m${ESC}[32mS1: merged${ESC}[0m\n`);
  });

  it("should draw the bottom line after a history line and clear the old one before it, so that the history is never overwritten", () => {
    const { view: v, writes, at } = view();
    const started = new Date(2026, 9, 28, 10, 0, 0);
    v.snapshot(runRecord(1, [running("S2", 1, started)]));
    at(10, 4, 12);

    v.progress("S1: merged");

    expect(writes.at(-1)).toBe(`${CLEAR_LINE}${ESC}[2m10:04:12 ${ESC}[0m${ESC}[32mS1: merged${ESC}[0m\n⏳ S2 attempt 1 · 4m12s · no activity yet`);
  });

  it("should count the time since the last activity of an attempt from its activity entries", () => {
    const { view: v, writes, at } = view();
    v.snapshot(runRecord(1, [running("S2", 1, new Date(2026, 9, 28, 10, 0, 0))]));
    v.activity({ source: "S2", at: new Date(2026, 9, 28, 10, 3, 37), event: { kind: "tool", tool: "Read" } });
    at(10, 4, 12);

    v.tick();

    expect(writes.at(-1)).toBe(`${CLEAR_LINE}⏳ S2 attempt 1 · 4m12s · last activity 35s ago`);
  });

  it("should redraw the bottom line on every tick with the new durations", () => {
    const { view: v, writes, at } = view();
    v.snapshot(runRecord(1, [running("S2", 1, new Date(2026, 9, 28, 10, 0, 0))]));
    at(10, 0, 5);
    v.tick();
    at(10, 0, 6);
    v.tick();

    expect(writes.slice(-2)).toEqual([
      `${CLEAR_LINE}⏳ S2 attempt 1 · 5s · no activity yet`,
      `${CLEAR_LINE}⏳ S2 attempt 1 · 6s · no activity yet`,
    ]);
  });

  it("should drop an attempt from the bottom line as soon as its record gets an outcome, with no end event, as with a deadline or an idle timeout", () => {
    const { view: v, writes } = view();
    v.snapshot(runRecord(1, [running("S1", 1, new Date(2026, 9, 28, 10, 0, 0))]));
    v.tick();
    v.snapshot(runRecord(1, [withOutcome("idle-timeout")]));

    v.tick();

    expect(writes.at(-1)).toBe(CLEAR_LINE);
    writes.length = 0;
    v.tick();
    expect(writes).toEqual([]);
  });

  it("should not carry the last activity of a finished attempt over to the next attempt of the same subtask", () => {
    const { view: v, writes, at } = view();
    v.snapshot(runRecord(1, [running("S1", 1, new Date(2026, 9, 28, 10, 0, 0))]));
    v.activity({ source: "S1", at: new Date(2026, 9, 28, 10, 0, 30), event: { kind: "tool", tool: "Read" } });
    v.snapshot(runRecord(1, [running("S1", 2, new Date(2026, 9, 28, 10, 1, 0))]));
    at(10, 1, 10);

    v.tick();

    expect(writes.at(-1)).toBe(`${CLEAR_LINE}⏳ S1 attempt 2 · 10s · no activity yet`);
  });

  it("should cut the bottom line to the width of the terminal so that it never wraps", () => {
    const { view: v, writes, at } = view(20);
    v.snapshot(runRecord(1, [running("S2", 1, new Date(2026, 9, 28, 10, 0, 0))]));
    at(10, 4, 12);

    v.tick();

    const text = (writes.at(-1) as string).replace(CLEAR_LINE, "");
    expect(text.length).toBeLessThanOrEqual(19);
    expect(text.endsWith("…")).toBe(true);
  });

  it("should dim an activity line in the history and keep its text", () => {
    const { view: v, writes } = view();

    v.activity({ source: "S1", at: new Date(2026, 9, 28, 10, 2, 20), event: { kind: "tool", tool: "Edit", target: "src/a.ts" } });

    expect((writes.join("").replace(CLEAR_LINE, "").replace(ansi, ""))).toBe("10:02:20 S1 · Edit src/a.ts\n");
  });

  it("should give each source a colour in order of first appearance, so the first sources of a run never share one", () => {
    const { view: v, writes } = view();
    const sources = ["S1", "S2", "S3", "verifier A1", "tester", "S4"];

    for (const source of sources) v.activity({ source, at: new Date(2026, 9, 28, 10, 0, 0), event: { kind: "tool", tool: "Read" } });

    const colours = writes.map((text) => new RegExp(`(\\u001b\\[[0-9;]*m)${"(?:S\\d|verifier A1|tester)"}`).exec(text)?.[1]);
    expect(new Set(colours).size).toBe(sources.length);
  });

  it("should clear the bottom line when the run ends and write nothing when none is drawn", () => {
    const { view: v, writes } = view();
    v.snapshot(runRecord(1, [running("S1", 1, new Date(2026, 9, 28, 10, 0, 0))]));
    v.progress("S1: working");
    writes.length = 0;

    v.finish();
    v.finish();

    expect(writes).toEqual([CLEAR_LINE]);
  });
});
