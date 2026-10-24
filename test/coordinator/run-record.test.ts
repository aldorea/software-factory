import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunLog } from "../../src/coordinator/run-log.ts";
import { CONFIG, harness, targetRepo, temp, writesHello } from "./harness.ts";

afterEach(() => temp.removeAll());

const RUN_ID = "42-2026-10-24T08-00-00-000Z";

function runJsonPath(repoDir: string): string {
  return join(repoDir, ".factory", "logs", RUN_ID, "run.json");
}

async function readRunLog(path: string): Promise<RunLog> {
  return JSON.parse(await readFile(path, "utf8")) as RunLog;
}

describe("the run record written by factory run", () => {
  it("should rewrite run.json at each state change, so that a reader sees the run while its subtask works", async () => {
    const target = await targetRepo();
    const seen: RunLog[] = [];
    const { run } = harness(target, (call) => {
      seen.push(JSON.parse(readFileSync(join(call.spec.logDir, "run.json"), "utf8")) as RunLog);
      return writesHello(call);
    });

    await run();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ result: "running", subtasks: [{ id: "S1", state: "working", attempts: [] }] });
    expect((await readRunLog(runJsonPath(target.repoDir))).result).toBe("ready");
  });

  it("should record the finished attempt before the gate starts, so that a run interrupted at the gate keeps what the worker spent", async () => {
    const snapshot = join(await temp.make("run-snapshot-"), "run.json");
    const target = await targetRepo();
    const config = CONFIG.replace(
      'command: "grep -q hello src/greeting.txt"',
      `command: "grep -q hello src/greeting.txt && (test -e ${snapshot} || cp ${join(target.repoDir, ".factory", "logs", RUN_ID, "run.json")} ${snapshot})"`,
    );
    await writeFile(join(target.repoDir, ".factory", "config.ts"), config);
    const { run } = harness(target, () => ({
      files: { "src/greeting.txt": "hello\n" },
      usage: { inputTokens: 7, outputTokens: 3 },
    }));

    await run();

    const atGate = await readRunLog(snapshot);
    expect(atGate.result).toBe("running");
    expect(atGate.subtasks[0]).toMatchObject({
      state: "gating",
      attempts: [{ number: 1, outcome: "completed", usage: { inputTokens: 7, outputTokens: 3 } }],
    });
  });

  it("should leave a valid run.json with the work done so far when the run crashes", async () => {
    const target = await targetRepo();
    const { run } = harness(target, () => {
      throw new Error("the coordinator was killed");
    });

    await expect(run()).rejects.toThrow("the coordinator was killed");

    const log = await readRunLog(runJsonPath(target.repoDir));
    expect(log).toMatchObject({ version: 1, runId: RUN_ID, issue: 42, result: "running" });
    expect(log.endedAt).toBeUndefined();
    expect(log.subtasks[0]).toMatchObject({ id: "S1", state: "working" });
    expect(existsSync(`${runJsonPath(target.repoDir)}.partial`)).toBe(false);
  });
});
