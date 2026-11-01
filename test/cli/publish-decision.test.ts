import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishDecision } from "../../src/cli/publish-decision.ts";
import { readRunEntry, type RunEntry } from "../../src/coordinator/run-history.ts";
import { writeRunLog, type RunResult } from "../../src/coordinator/run-log.ts";
import { temp } from "../coordinator/harness.ts";
import { runRecord } from "../coordinator/run-log-fixtures.ts";
import { writeRunningRun } from "../coordinator/running-run.ts";

afterEach(() => temp.removeAll());

const NOW = new Date("2026-10-24T10:30:00.000Z");
const MINUTE = 60_000;

async function entryWith(result: RunResult): Promise<RunEntry> {
  const logsDir = await temp.make("publish-decision-");
  const log = runRecord(0, [], { runId: "1-run-00", result });
  await mkdir(join(logsDir, log.runId), { recursive: true });
  await writeRunLog(join(logsDir, log.runId, "run.json"), log);
  const read = await readRunEntry(logsDir, log.runId);
  if (read.kind !== "found") throw new Error("run.json was not read");
  return read.entry;
}

async function runningEntry(silentMs: number): Promise<RunEntry> {
  const logsDir = await temp.make("publish-decision-running-");
  const run = await writeRunningRun({
    logsDir,
    runJsonAt: new Date(NOW.getTime() - silentMs),
    logAt: new Date(NOW.getTime() - silentMs),
  });
  const read = await readRunEntry(logsDir, run.runId);
  if (read.kind !== "found") throw new Error("run.json was not read");
  return read.entry;
}

describe("publishDecision", () => {
  it.each(["ready", "draft", "paused"] as const)("should publish a %s run", async (result) => {
    expect(publishDecision(await entryWith(result), NOW)).toEqual({ kind: "publish" });
  });

  it("should refuse a run that is still running, and say that its work is not done", async () => {
    const decision = publishDecision(await runningEntry(MINUTE), NOW);

    expect(decision.kind).toBe("refuse");
    if (decision.kind === "refuse") expect(decision.reason).toContain("is still running");
  });

  it("should refuse an abandoned run with its own reason, because its integration branch may hold half-done work", async () => {
    const decision = publishDecision(await runningEntry(60 * MINUTE), NOW);

    expect(decision.kind).toBe("refuse");
    if (decision.kind === "refuse") {
      expect(decision.reason).toContain("was abandoned");
      expect(decision.reason).toContain("factory run");
    }
  });
});
