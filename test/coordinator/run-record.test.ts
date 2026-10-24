import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunLog } from "../../src/coordinator/run-log.ts";
import { WorkerLayerError } from "../../src/workers/failures.ts";
import { BRANCH, CONFIG, harness, targetRepo, temp, WITH_HUMAN_CRITERION, writesBye, writesHello } from "./harness.ts";

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

  it("should record the tokens of each subtask, per agent and per run, the attempts and the wall clock of the run", async () => {
    const target = await targetRepo();
    const usage = { inputTokens: 120, cacheCreationInputTokens: 5, cacheReadInputTokens: 40, outputTokens: 30 };
    const h = harness(target, () => {
      h.clock.advance(90_000);
      return { files: { "src/greeting.txt": "hello\n" }, usage };
    });

    const report = await h.run();

    const log = await readRunLog(report.runLogPath);
    expect(log.subtasks[0]?.usage).toEqual(usage);
    expect(log.cost).toEqual({
      usage,
      perAgent: { "claude-code": usage },
      attempts: 1,
      wallClockMs: 90_000,
      pausedMs: 0,
    });
  });

  it("should split the criteria into the ones that pass, the blocked ones and the human ones", async () => {
    const passing = await targetRepo(WITH_HUMAN_CRITERION);
    const blocked = await targetRepo(WITH_HUMAN_CRITERION);

    const ready = await harness(passing, writesHello).run();
    const rejected = await harness(blocked, writesBye).run();

    expect(ready.log.criteria).toEqual({ passing: ["A1"], blocked: [], human: ["A2"], pending: [] });
    expect(rejected.log.criteria).toEqual({ passing: [], blocked: ["A1"], human: ["A2"], pending: [] });
  });

  it("should count a rejection by the gate as friction and not as a failure of the worker layer", async () => {
    const target = await targetRepo();

    const report = await harness(target, writesBye).run();

    expect(report.log.workerLayerFailures).toEqual([]);
    expect(report.log.friction).toEqual({
      blocks: { scope: 0, "design-question": 0, patience: 0, limit: 0, environment: 0 },
      scopeExtensions: 0,
      gateRejections: 1,
      verifierRejections: 0,
      integrationConflicts: 0,
    });
  });

  it("should count the block of a subtask by its type", async () => {
    const target = await targetRepo();

    const report = await harness(target, () => ({ outcome: { kind: "deadline" } })).run();

    expect(report.log.subtasks[0]).toMatchObject({ state: "blocked", blockType: "limit" });
    expect(report.log.friction.blocks).toEqual({ scope: 0, "design-question": 0, patience: 0, limit: 1, environment: 0 });
  });

  it("should count an integration conflict when the subtask cannot merge into the integration branch", async () => {
    const target = await targetRepo();
    const elsewhere = await temp.make("run-conflict-");
    const { run } = harness(target, () => {
      const worktree = join(elsewhere, "integration");
      execFileSync("git", ["-C", target.repoDir, "worktree", "add", "-q", worktree, BRANCH]);
      mkdirSync(join(worktree, "src"), { recursive: true });
      writeFileSync(join(worktree, "src", "greeting.txt"), "hello from the integration branch\n");
      execFileSync("git", ["-C", worktree, "add", "-A"]);
      execFileSync("git", ["-C", worktree, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "Move the integration branch"]);
      execFileSync("git", ["-C", target.repoDir, "worktree", "remove", "--force", worktree]);
      return { files: { "src/greeting.txt": "hello from the worker\n" } };
    });

    const report = await run();

    expect(report.log.subtasks[0]).toMatchObject({ state: "blocked", conflicts: 1 });
    expect(report.log.friction.integrationConflicts).toBe(1);
  });

  it("should record a container that does not start as a failure of the worker layer, apart from the blocks, and open a draft", async () => {
    const target = await targetRepo();
    const { run, clock } = harness(target, writesHello, {
      start: (spec) => (spec.id === "42-S1" ? new Error("docker: no such image greeting-worker:dev") : undefined),
    });

    const report = await run();

    expect(report.result).toBe("draft");
    expect(report.log.workerLayerFailures).toEqual([
      {
        kind: "container-start",
        stage: "start",
        subtask: "S1",
        message: "docker: no such image greeting-worker:dev",
        at: clock.now().toISOString(),
      },
    ]);
    expect(report.log.subtasks[0]).toMatchObject({ state: "interrupted", attempts: [] });
    expect(report.log.friction.blocks).toEqual({ scope: 0, "design-question": 0, patience: 0, limit: 0, environment: 0 });
    expect(report.log.criteria).toMatchObject({ blocked: [], pending: ["A1"] });
    expect(target.github.pullRequests[0]?.draft).toBe(true);
    expect(target.github.pullRequests[0]?.body).toContain("1 failure of the worker layer");
  });

  it("should record a worker layer error raised during the attempt with the kind it names", async () => {
    const target = await targetRepo();
    const { run } = harness(target, writesHello, {
      attempt: () => new WorkerLayerError("usage-unreadable", "attempt", "the stream has no usage line"),
    });

    const report = await run();

    expect(report.log.workerLayerFailures).toMatchObject([
      { kind: "usage-unreadable", stage: "attempt", subtask: "S1", message: "the stream has no usage line" },
    ]);
    expect(report.log.subtasks[0]?.state).toBe("interrupted");
  });

  it("should keep the checks of the gate when closing its worker fails, and record the failure of the cleanup", async () => {
    const target = await targetRepo();
    const { run } = harness(target, writesHello, {
      close: (spec) => (spec.id.endsWith("-gate") ? new Error("git worktree remove failed") : undefined),
    });

    const report = await run();

    expect(report.log.workerLayerFailures).toMatchObject([
      { kind: "commit-or-cleanup", stage: "close", subtask: "S1", message: "git worktree remove failed" },
    ]);
    expect(report.log.subtasks[0]).toMatchObject({ state: "merged", gate: { accepted: true } });
    expect(report.result).toBe("ready");
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
