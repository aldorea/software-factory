import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIssue } from "../../src/coordinator/run.ts";
import { writeRunLog, type RunLog } from "../../src/coordinator/run-log.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeVerifier } from "../fakes/verifier.ts";
import { FakeWorkerRunner, type AttemptScript } from "../fakes/worker-runner.ts";
import { CONFIG, ISSUE, ISSUE_BODY, specText, targetRepo, temp, TOKEN, type Target } from "./harness.ts";
import { cleanRun, failedRun, pausedRun } from "./run-log-fixtures.ts";

afterEach(() => temp.removeAll());

const TWO_INDEPENDENT = {
  issueBody: ISSUE_BODY.replace("A1 The greeting says hello.", "A1 The greeting says hello.\n- [ ] A2 The farewell says bye."),
  spec: specText({
    files: { A1: ["src/greeting.txt"], A2: ["lib/farewell.txt"] },
    base: null,
    subtasks: [
      { id: "S1", criteria: ["A1"], scope: ["src/"], dependsOn: [], testChanges: [] },
      { id: "S2", criteria: ["A2"], scope: ["lib/"], dependsOn: [], testChanges: [] },
    ],
    criteria: { A1: { evidence: "request", level: "subtask" }, A2: { evidence: "request", level: "subtask" } },
  }),
  config: CONFIG.replace(
    'checks: [{ name: "greeting", command: "grep -q hello src/greeting.txt" }]',
    'checks: [{ name: "parts", command: "true" }]',
  ).replace('evidence: { request: "grep -q hello src/greeting.txt # {{id}}" }', 'evidence: { request: "true # {{id}}" }'),
};

const withAgents = (agents: string) => ({
  ...TWO_INDEPENDENT,
  config: TWO_INDEPENDENT.config.replace("  roles:", `  agents: ${agents},\n  roles:`),
});

const writesOwnFile: AttemptScript = (call) =>
  call.spec.branch.endsWith("/S1") ? { files: { "src/greeting.txt": "hello\n" } } : { files: { "lib/farewell.txt": "bye\n" } };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function withHistory(target: Target, history: RunLog[]): Promise<void> {
  for (const log of history) await writeRunLog(join(target.repoDir, ".factory", "logs", log.runId, "run.json"), log);
}

function observedRun(target: Target) {
  let active = 0;
  const observer = { peak: 0 };
  const script: AttemptScript = async (call) => {
    active += 1;
    observer.peak = Math.max(observer.peak, active);
    await sleep(120);
    active -= 1;
    return call.spec.branch.endsWith("/S1")
      ? { files: { "src/greeting.txt": "hello\n" } }
      : { files: { "lib/farewell.txt": "bye\n" } };
  };
  const runner = new FakeWorkerRunner(script);
  const clock = new FakeClock("2026-10-24T08:00:00.000Z");
  const run = () =>
    runIssue(
      { repoDir: target.repoDir, issue: ISSUE, credentials: { "claude-code": TOKEN } },
      { runner, verifier: new FakeVerifier(), github: target.github, notifier: new FakeNotifier(), clock },
    );
  return { observer, run };
}

const threeClean = () => [cleanRun(0), cleanRun(1), cleanRun(2)];

describe("factory run with the maxParallel derived from the run history", () => {
  it("should run one subtask at a time and record maxParallel 1 when there is no history", async () => {
    const target = await targetRepo(TWO_INDEPENDENT);
    const { observer, run } = observedRun(target);

    const report = await run();

    expect(report.result).toBe("ready");
    expect(observer.peak).toBe(1);
    expect(report.log.maxParallel).toBe(1);
  });

  it("should run 2 subtasks at once after 3 runs in a row with no worker-layer failure, and record it in run.json", async () => {
    const target = await targetRepo(TWO_INDEPENDENT);
    await withHistory(target, threeClean());
    const { observer, run } = observedRun(target);

    const report = await run();

    expect(report.result).toBe("ready");
    expect(observer.peak).toBe(2);
    expect(report.log.maxParallel).toBe(2);
  });

  it("should write the derived maxParallel to the run.json on disk", async () => {
    const target = await targetRepo(TWO_INDEPENDENT);
    await withHistory(target, threeClean());
    const { run } = observedRun(target);

    const report = await run();

    expect(JSON.parse(await readFile(report.runLogPath, "utf8")).maxParallel).toBe(2);
  });

  it("should stay at 1 when a worker-layer failure broke the streak of clean runs", async () => {
    const target = await targetRepo(TWO_INDEPENDENT);
    await withHistory(target, [cleanRun(0), failedRun(1), cleanRun(2), cleanRun(3)]);
    const { observer, run } = observedRun(target);

    await run();

    expect(observer.peak).toBe(1);
  });

  it("should go down by one after a pause of the agent", async () => {
    const target = await targetRepo(withAgents('{ "claude-code": { maxParallel: 2 } }'));
    await withHistory(target, [pausedRun(0)]);
    const { observer, run } = observedRun(target);

    const report = await run();

    expect(observer.peak).toBe(1);
    expect(report.log.maxParallel).toBe(1);
  });

  it("should keep to the ceiling of the config however good the history is", async () => {
    const target = await targetRepo(withAgents('{ "claude-code": { maxParallelCeiling: 1 } }'));
    await withHistory(target, [...threeClean(), cleanRun(3), cleanRun(4), cleanRun(5)]);
    const { observer, run } = observedRun(target);

    const report = await run();

    expect(observer.peak).toBe(1);
    expect(report.log.maxParallel).toBe(1);
  });

  it("should not count the runs of another agent", async () => {
    const target = await targetRepo(TWO_INDEPENDENT);
    await withHistory(target, [cleanRun(0, "opencode"), cleanRun(1, "opencode"), cleanRun(2, "opencode")]);
    const { observer, run } = observedRun(target);

    await run();

    expect(observer.peak).toBe(1);
  });
});

describe("factory run recording its own pauses", () => {
  const limited: AttemptScript = () => ({ outcome: { kind: "plan-limit", message: "5-hour limit reached" } });

  it("should record the agent and the time of the pause in run.json", async () => {
    const target = await targetRepo(TWO_INDEPENDENT);
    const runner = new FakeWorkerRunner(limited);
    const clock = new FakeClock("2026-10-24T08:00:00.000Z");

    const report = await runIssue(
      { repoDir: target.repoDir, issue: ISSUE, credentials: { "claude-code": TOKEN } },
      { runner, verifier: new FakeVerifier(), github: target.github, notifier: new FakeNotifier(), clock },
    );

    expect(report.result).toBe("paused");
    expect(report.log.pauses).toEqual([{ agent: "claude-code", at: "2026-10-24T08:00:00.000Z" }]);
  });

  it("should keep the pause in run.json after the run resumes and finishes, so the next run still sees it", async () => {
    const target = await targetRepo(withAgents('{ "claude-code": { maxParallel: 2 } }'));
    const ports = (script: AttemptScript, at: string) => ({
      runner: new FakeWorkerRunner(script),
      verifier: new FakeVerifier(),
      github: target.github,
      notifier: new FakeNotifier(),
      clock: new FakeClock(at),
    });
    const request = { repoDir: target.repoDir, issue: ISSUE, credentials: { "claude-code": TOKEN } };
    await runIssue(request, ports(limited, "2026-10-24T08:00:00.000Z"));

    const resumed = await runIssue(request, ports(writesOwnFile, "2026-10-24T13:30:00.000Z"));

    expect(resumed.result).toBe("ready");
    expect(resumed.log.pauses).toEqual([{ agent: "claude-code", at: "2026-10-24T08:00:00.000Z" }]);
    expect(resumed.log.maxParallel).toBe(1);
  });
});
