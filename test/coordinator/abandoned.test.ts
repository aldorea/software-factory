import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { abandonedLogs, attemptAbandoned, idleTimeoutOf, lastChange, runAbandoned, runStatus } from "../../src/coordinator/abandoned.ts";
import { readRunEntry, type RunEntry } from "../../src/coordinator/run-history.ts";
import { writeRunLog } from "../../src/coordinator/run-log.ts";
import { temp } from "./harness.ts";
import { writeRunningRun } from "./running-run.ts";

afterEach(() => temp.removeAll());

const TIMEOUT = 10 * 60_000;
const NOW = new Date("2026-10-24T10:30:00.000Z");

function before(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

async function runningEntry(runJsonSilentMs: number, logSilentMs: number): Promise<RunEntry> {
  const logsDir = await temp.make("abandoned-");
  const run = await writeRunningRun({ logsDir, runJsonAt: before(runJsonSilentMs), logAt: before(logSilentMs) });
  const read = await readRunEntry(logsDir, run.runId);
  if (read.kind !== "found") throw new Error("run.json was not read");
  return read.entry;
}

function onlyAttempt(entry: RunEntry) {
  return entry.log.subtasks[0]!.attempts[0]!;
}

describe("an attempt still running", () => {
  it("should not be abandoned while its raw log changed within attemptIdleTimeoutMs", async () => {
    const entry = await runningEntry(60 * 60_000, TIMEOUT - 1000);

    expect(attemptAbandoned(onlyAttempt(entry), entry, NOW)).toBe(false);
  });

  it("should not be abandoned when its raw log changed exactly attemptIdleTimeoutMs ago because only longer is silence", async () => {
    const entry = await runningEntry(60 * 60_000, TIMEOUT);

    expect(attemptAbandoned(onlyAttempt(entry), entry, NOW)).toBe(false);
  });

  it("should be abandoned when its raw log has not changed for longer than attemptIdleTimeoutMs", async () => {
    const entry = await runningEntry(60 * 60_000, TIMEOUT + 1000);

    expect(attemptAbandoned(onlyAttempt(entry), entry, NOW)).toBe(true);
  });

  it("should not depend on run.json, which does not change while the attempt works", async () => {
    const entry = await runningEntry(TIMEOUT - 1000, TIMEOUT + 1000);

    expect(attemptAbandoned(onlyAttempt(entry), entry, NOW)).toBe(true);
  });

  it("should count from its start when its raw log does not exist yet", async () => {
    const logsDir = await temp.make("abandoned-nolog-");
    const run = await writeRunningRun({ logsDir, runJsonAt: before(TIMEOUT + 1000), logAt: before(0) });
    const missing = { log: run.log, logTimes: new Map<string, Date>() };
    const attempt = run.log.subtasks[0]!.attempts[0]!;

    expect(attemptAbandoned(attempt, missing, NOW)).toBe(true);
    expect(attemptAbandoned({ ...attempt, startedAt: before(1000).toISOString() }, missing, NOW)).toBe(false);
  });

  it("should never be abandoned once it has an outcome", async () => {
    const entry = await runningEntry(60 * 60_000, 60 * 60_000);

    expect(attemptAbandoned({ ...onlyAttempt(entry), outcome: "completed" }, entry, NOW)).toBe(false);
  });
});

describe("a run still running", () => {
  it("should not be abandoned when its run.json changed within attemptIdleTimeoutMs", async () => {
    const entry = await runningEntry(TIMEOUT - 1000, 60 * 60_000);

    expect(runAbandoned(entry, NOW)).toBe(false);
    expect(runStatus(entry, NOW)).toBe("running");
  });

  it("should not be abandoned when its attempt keeps writing the raw log although run.json did not change", async () => {
    const entry = await runningEntry(2 * 60 * 60_000, 30_000);

    expect(runAbandoned(entry, NOW)).toBe(false);
    expect(runStatus(entry, NOW)).toBe("running");
  });

  it("should be abandoned when neither its run.json nor its raw logs changed for longer than attemptIdleTimeoutMs", async () => {
    const entry = await runningEntry(TIMEOUT + 1000, TIMEOUT + 2000);

    expect(runAbandoned(entry, NOW)).toBe(true);
    expect(runStatus(entry, NOW)).toBe("abandoned");
  });

  it("should be abandoned from 10:11 when factory run died at 10:00 with the default of 10 minutes", async () => {
    const logsDir = await temp.make("abandoned-example-");
    const diedAt = new Date("2026-10-24T10:00:00.000Z");
    const run = await writeRunningRun({ logsDir, runJsonAt: diedAt, logAt: diedAt });
    const read = await readRunEntry(logsDir, run.runId);
    if (read.kind !== "found") throw new Error("run.json was not read");

    expect(runAbandoned(read.entry, new Date("2026-10-24T10:10:00.000Z"))).toBe(false);
    expect(runAbandoned(read.entry, new Date("2026-10-24T10:11:00.000Z"))).toBe(true);
  });

  it("should report the last change as the newest of run.json and its raw logs", async () => {
    const entry = await runningEntry(60 * 60_000, 5 * 60_000);

    expect(lastChange(entry)).toEqual(before(5 * 60_000));
  });

  it.each(["ready", "draft", "paused"] as const)("should never be abandoned when its result is %s", async (result) => {
    const logsDir = await temp.make("abandoned-finished-");
    const run = await writeRunningRun({ logsDir, runJsonAt: before(60 * 60_000), logAt: before(60 * 60_000) });
    const entry: RunEntry = { dir: run.runId, log: { ...run.log, result }, modifiedAt: before(60 * 60_000), logTimes: new Map() };

    expect(runAbandoned(entry, NOW)).toBe(false);
    expect(runStatus(entry, NOW)).toBe(result);
  });

  it("should read the modification times of the raw logs only for a run still running", async () => {
    const logsDir = await temp.make("abandoned-read-");
    const run = await writeRunningRun({ logsDir, runJsonAt: before(60_000), logAt: before(30_000) });
    const ended = { ...run.log, result: "ready" as const };
    await writeRunLog(join(run.runDir, "run.json"), ended);

    const read = await readRunEntry(logsDir, run.runId);

    expect(read.kind === "found" && read.entry.logTimes.size).toBe(0);
  });
});

describe("the threshold of a run", () => {
  const LONG = 60 * 60_000;

  async function withThreshold(attemptIdleTimeoutMs: number | undefined, silentMs: number): Promise<RunEntry> {
    const entry = await runningEntry(silentMs, silentMs);
    const { attemptIdleTimeoutMs: _dropped, ...log } = entry.log;
    return { ...entry, log: attemptIdleTimeoutMs === undefined ? log : { ...log, attemptIdleTimeoutMs } };
  }

  it("should be the attemptIdleTimeoutMs the run log recorded", async () => {
    const entry = await withThreshold(LONG, 30 * 60_000);

    expect(idleTimeoutOf(entry.log)).toBe(LONG);
    expect(runAbandoned(entry, NOW)).toBe(false);
    expect(runStatus(entry, NOW)).toBe("running");
    expect(attemptAbandoned(onlyAttempt(entry), entry, NOW)).toBe(false);
  });

  it("should make a run abandoned sooner when its log recorded a shorter attemptIdleTimeoutMs than the default", async () => {
    const entry = await withThreshold(60_000, 5 * 60_000);

    expect(runAbandoned(entry, NOW)).toBe(true);
    expect(attemptAbandoned(onlyAttempt(entry), entry, NOW)).toBe(true);
  });

  it("should be the default of 10 minutes for a run log without the field, as the runs of older versions", async () => {
    const entry = await withThreshold(undefined, 30 * 60_000);

    expect(idleTimeoutOf(entry.log)).toBe(TIMEOUT);
    expect(runAbandoned(entry, NOW)).toBe(true);
  });

  it("should be read from each run log, so two runs of one repo can have different thresholds", async () => {
    const patient = await withThreshold(LONG, 30 * 60_000);
    const impatient = await withThreshold(undefined, 30 * 60_000);

    expect(abandonedLogs([patient, impatient], NOW)).toEqual(new Set([impatient.log]));
  });
});
