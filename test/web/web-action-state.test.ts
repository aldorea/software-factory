import { describe, expect, it } from "vitest";
import { webActionState, type WebActionRecord } from "../../src/web/web-action.ts";

const NOW = new Date("2026-11-07T10:45:00.000Z");

const record: WebActionRecord = {
  version: 1,
  id: "2026-11-07T10-42-00-000Z-run-28",
  command: "run",
  args: ["run", "28", "--worker-agent", "claude-code:opus"],
  issue: 28,
  startedAt: "2026-11-07T10:42:00.000Z",
  pid: 4242,
  processStart: "Sat Nov  7 10:42:00 2026",
};

describe("the state of a web action", () => {
  it("should be running while its process lives with the start time of action.json, with the time it has worked", () => {
    expect(webActionState(record, null, { startTime: "Sat Nov  7 10:42:00 2026" }, NOW)).toEqual({ kind: "running", elapsedMs: 180_000 });
  });

  it("should be ended with its exit code when the CLI recorded its end, whatever the process", () => {
    const end = { exitCode: 1, endedAt: "2026-11-07T10:43:00.000Z" };

    expect(webActionState(record, end, { startTime: null }, NOW)).toEqual({ kind: "ended", exitCode: 1, endedAt: end.endedAt });
    expect(webActionState(record, end, { startTime: record.processStart }, NOW)).toEqual({ kind: "ended", exitCode: 1, endedAt: end.endedAt });
  });

  it("should be interrupted when it has no end and its process is gone", () => {
    expect(webActionState(record, null, { startTime: null }, NOW)).toEqual({ kind: "interrupted" });
  });

  it("should be interrupted when its process number lives with another start time, because the system reused the number for a stranger's process", () => {
    expect(webActionState(record, null, { startTime: "Sat Nov  7 11:00:00 2026" }, NOW)).toEqual({ kind: "interrupted" });
  });

  it("should be interrupted when the server could not read the start time of its process, so Stop never signals a process it cannot recognise", () => {
    expect(webActionState({ ...record, processStart: null }, null, { startTime: "Sat Nov  7 10:42:00 2026" }, NOW)).toEqual({ kind: "interrupted" });
  });
});
