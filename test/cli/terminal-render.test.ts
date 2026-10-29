import { describe, expect, it } from "vitest";
import {
  renderActivity,
  renderProgress,
  runningAttempts,
  sourceColours,
  statusLine,
  type RunningAttempt,
} from "../../src/cli/terminal-render.ts";
import type { ActivityEntry } from "../../src/coordinator/ports.ts";
import type { AttemptRecord } from "../../src/coordinator/run-log.ts";
import { attemptRecord, runRecord, subtaskRecord } from "../coordinator/run-log-fixtures.ts";

const ESC = String.fromCharCode(27);
const ansi = /\u001b\[[0-9;]*[A-Za-z]/;
const at = new Date(2026, 9, 28, 10, 2, 20);
const entry = (source: string, event: ActivityEntry["event"] = { kind: "tool", tool: "Edit", target: "src/a.ts" }): ActivityEntry => ({
  source,
  at,
  event,
});

describe("progress rendering", () => {
  it("should start a plain progress line with the local time as hh:mm:ss when the output is not a terminal", () => {
    expect(renderProgress("S1: merged", at, false)).toBe("10:02:20 S1: merged");
    expect(renderProgress("S1: merged", at, false)).not.toMatch(ansi);
  });

  it("should dim the time of a progress line in a terminal and colour a merged subtask in green", () => {
    expect(renderProgress("S1: merged", at, true)).toBe(`${ESC}[2m10:02:20 ${ESC}[0m${ESC}[32mS1: merged${ESC}[0m`);
  });

  it("should colour a blocked subtask in red, with its block type", () => {
    expect(renderProgress("S2: blocked (patience)", at, true)).toBe(`${ESC}[2m10:02:20 ${ESC}[0m${ESC}[31mS2: blocked (patience)${ESC}[0m`);
  });

  it("should colour the pause of the run in yellow", () => {
    expect(renderProgress("run paused: claude-code plan limit", at, true)).toBe(
      `${ESC}[2m10:02:20 ${ESC}[0m${ESC}[33mrun paused: claude-code plan limit${ESC}[0m`,
    );
    expect(renderProgress("run 42-a1: paused", at, true)).toBe(`${ESC}[2m10:02:20 ${ESC}[0m${ESC}[33mrun 42-a1: paused${ESC}[0m`);
  });

  it("should leave any other progress line in normal text after its dim time", () => {
    expect(renderProgress("S1: attempt 1 completed", at, true)).toBe(`${ESC}[2m10:02:20 ${ESC}[0mS1: attempt 1 completed`);
    expect(renderProgress("S1: working", at, true)).toBe(`${ESC}[2m10:02:20 ${ESC}[0mS1: working`);
    expect(renderProgress("pull request: https://github.test/pull/1", at, true)).toBe(
      `${ESC}[2m10:02:20 ${ESC}[0mpull request: https://github.test/pull/1`,
    );
  });
});

describe("activity rendering", () => {
  it("should give the same text as the plain activity line when the output is not a terminal", () => {
    expect(renderActivity(entry("S1"), false, sourceColours())).toBe("10:02:20 S1 · Edit src/a.ts");
    expect(renderActivity(entry("S1"), false, sourceColours())).not.toMatch(ansi);
  });

  it("should dim the whole line of a terminal and colour the prefix", () => {
    const rendered = renderActivity(entry("S1"), true, sourceColours());

    expect(rendered).toMatch(ansi);
    expect(rendered.replace(new RegExp(ansi, "g"), "")).toBe("10:02:20 S1 · Edit src/a.ts");
    expect(rendered.startsWith(`${ESC}[2m10:02:20 ${ESC}[0m`)).toBe(true);
    expect(rendered.endsWith(`${ESC}[2m · Edit src/a.ts${ESC}[0m`)).toBe(true);
  });

  it("should give the first sources of a run distinct colours, in order of first appearance, and the same colour every time", () => {
    const colours = sourceColours();
    const sources = ["S1", "S2", "S3", "verifier A3", "tester", "S4"];

    const first = sources.map((source) => colours(source));

    expect(new Set(first).size).toBe(sources.length);
    expect(sources.map((source) => colours(source))).toEqual(first);
  });

  it("should not depend on the name of the source for its colour, so two names with the same character sum still differ", () => {
    const colours = sourceColours();

    expect(colours("S12")).not.toBe(colours("S21"));
  });

  it("should start again from the first colour for each run", () => {
    expect(sourceColours()("tester")).toBe(sourceColours()("S1"));
  });

  it("should colour the prefix of the verifier and the tester by their source string", () => {
    const colours = sourceColours();
    const colour = (source: string) => new RegExp(`(\\u001b\\[[0-9;]*m)${source}`).exec(renderActivity(entry(source), true, colours))?.[1];

    expect(colour("verifier A3")).toBeDefined();
    expect(colour("verifier A3")).toBe(colour("verifier A3"));
    expect(colour("tester")).toBeDefined();
    expect(colour("tester")).not.toBe(colour("verifier A3"));
  });
});

const attemptWith = (overrides: Partial<AttemptRecord>): AttemptRecord => ({ ...attemptRecord("claude-code", 1, 1), ...overrides });

describe("running attempts", () => {
  it("should list the attempts of the run log that have no outcome yet, with the subtask as source", () => {
    const log = runRecord(1, [
      subtaskRecord("S1", { attempts: [attemptWith({ number: 1, outcome: "completed" })] }),
      subtaskRecord("S2", {
        attempts: [
          attemptWith({ number: 1, outcome: "agent-error" }),
          attemptWith({ number: 2, outcome: "running", startedAt: "2026-10-28T10:00:00.000Z" }),
        ],
      }),
    ]);

    expect(runningAttempts(log)).toEqual([{ source: "S2", number: 2, startedAt: new Date("2026-10-28T10:00:00.000Z") }]);
  });

  it("should drop an attempt that ended by deadline or idle timeout, which emits no end event, as soon as its record has an outcome", () => {
    const record = (outcome: AttemptRecord["outcome"]) => runRecord(1, [subtaskRecord("S1", { attempts: [attemptWith({ outcome })] })]);

    expect(runningAttempts(record("running"))).toHaveLength(1);
    expect(runningAttempts(record("deadline"))).toEqual([]);
    expect(runningAttempts(record("idle-timeout"))).toEqual([]);
  });
});

describe("bottom line", () => {
  const started = new Date(2026, 9, 28, 10, 0, 0);
  const attempt = (source: string, number = 1, startedAt = started): RunningAttempt => ({ source, number, startedAt });

  it("should show the attempt, its duration and the time since its last activity", () => {
    const now = new Date(2026, 9, 28, 10, 4, 12);
    const last = new Map([["S2", new Date(2026, 9, 28, 10, 3, 37)]]);

    expect(statusLine([attempt("S2")], last, now)).toBe("⏳ S2 attempt 1 · 4m12s · last activity 35s ago");
  });

  it("should say there is no activity yet for an attempt that has emitted none", () => {
    const now = new Date(2026, 9, 28, 10, 0, 7);

    expect(statusLine([attempt("S1")], new Map(), now)).toBe("⏳ S1 attempt 1 · 7s · no activity yet");
  });

  it("should write the duration in hours, minutes and seconds with two digits where a smaller unit follows", () => {
    const last = new Map([["S1", new Date(2026, 9, 28, 11, 2, 0)]]);

    expect(statusLine([attempt("S1")], last, new Date(2026, 9, 28, 11, 2, 5))).toBe("⏳ S1 attempt 1 · 1h02m05s · last activity 5s ago");
    expect(statusLine([attempt("S1")], new Map(), new Date(2026, 9, 28, 10, 5, 3))).toBe("⏳ S1 attempt 1 · 5m03s · no activity yet");
  });

  it("should show every attempt in progress on the same line", () => {
    const now = new Date(2026, 9, 28, 10, 1, 0);
    const last = new Map([
      ["S1", new Date(2026, 9, 28, 10, 0, 50)],
      ["S2", new Date(2026, 9, 28, 10, 0, 59)],
    ]);

    expect(statusLine([attempt("S1"), attempt("S2", 2)], last, now)).toBe(
      "⏳ S1 attempt 1 · 1m00s · last activity 10s ago   ⏳ S2 attempt 2 · 1m00s · last activity 1s ago",
    );
  });

  it("should be empty when no attempt is in progress", () => {
    expect(statusLine([], new Map(), started)).toBe("");
  });
});
