import { afterEach, describe, expect, it } from "vitest";
import { runIssue } from "../../src/coordinator/run.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeVerifier, type VerifierScript } from "../fakes/verifier.ts";
import { FakeWorkerRunner, type AttemptScript } from "../fakes/worker-runner.ts";
import { CONFIG, harness, ISSUE, ISSUE_BODY, specText, targetRepo, temp, TOKEN, type Target } from "./harness.ts";

afterEach(() => temp.removeAll());

const RESETS_AT = new Date("2026-10-24T13:00:00.000Z");

const TWO_SUBTASKS = {
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
    'checks: [{ name: "parts", command: "! grep -rq BAD src lib 2>/dev/null" }]',
  )
    .replace('evidence: { request: "grep -q hello src/greeting.txt # {{id}}" }', 'evidence: { request: "true # {{id}}" }')
    .replace("  roles:", '  agents: { "claude-code": { maxParallel: 2 } },\n  roles:'),
};

const WITH_PLAYWRIGHT = {
  spec: specText({
    files: { A1: ["src/greeting.txt"] },
    base: null,
    subtasks: [{ id: "S1", criteria: ["A1"], scope: ["src/", "tests/"], dependsOn: [], testChanges: [] }],
    criteria: { A1: { evidence: "playwright", level: "subtask" } },
  }),
  config: CONFIG.replace(
    'evidence: { request: "grep -q hello src/greeting.txt # {{id}}" }',
    'evidence: { playwright: "grep -q hello src/greeting.txt # {{id}}" }',
  ),
};

const writesGreetingAndTest: AttemptScript = () => ({
  files: { "src/greeting.txt": "hello\n", "tests/greeting.spec.ts": 'test("A1 says hello", () => {});\n' },
});

function factory(target: Target, script: AttemptScript, options: { at?: string; verifier?: VerifierScript } = {}) {
  const runner = new FakeWorkerRunner(script);
  const verifier = new FakeVerifier(options.verifier);
  const notifier = new FakeNotifier();
  const clock = new FakeClock(options.at ?? "2026-10-24T08:00:00.000Z");
  const run = () =>
    runIssue(
      { repoDir: target.repoDir, issue: ISSUE, credentials: { "claude-code": TOKEN } },
      { runner, verifier, github: target.github, notifier, clock },
    );
  return { runner, verifier, notifier, clock, run };
}

const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("factory run at the plan limit", () => {
  it("should give the reason and the reset time in the draft pull request, the notification and run.json", async () => {
    const target = await targetRepo();
    const { run, notifier } = harness(target, () => ({
      outcome: { kind: "plan-limit", message: "5-hour limit reached", resetsAt: RESETS_AT },
    }));

    const report = await run();

    expect(report.log).toMatchObject({ result: "paused", resetsAt: RESETS_AT.toISOString() });
    const body = target.github.pullRequests[0]?.body ?? "";
    expect(body).toContain("the plan limit of claude-code was reached: 5-hour limit reached");
    expect(body).toContain(`It resets at ${RESETS_AT.toISOString()}`);
    expect(notifier.sent[0]?.message).toContain(`resets at ${RESETS_AT.toISOString()}`);
    expect(notifier.sent[0]?.url).toBe(report.pullRequest.url);
  });

  it("should let a running worker finish its attempt but start no new attempt or worker once the run pauses", async () => {
    const target = await targetRepo(TWO_SUBTASKS);
    const { run, runner } = harness(target, async (call) => {
      if (call.spec.branch.endsWith("/S1")) return { outcome: { kind: "plan-limit", message: "5-hour limit reached" } };
      await settle(300);
      return { files: { "lib/farewell.txt": "BAD\n" } };
    });

    const report = await run();

    expect(report.result).toBe("paused");
    expect(runner.workers.filter((worker) => worker.attempts.length > 0).map((worker) => worker.attempts.length)).toEqual([1, 1]);
    expect(report.log.subtasks.map((subtask) => subtask.state)).toEqual(["pending", "pending"]);
    expect(report.log.subtasks[1]?.gateRejections).toBe(1);
  });

  it("should pause the run, not reject the attempt, when the independent verifier reaches its plan limit", async () => {
    const target = await targetRepo(WITH_PLAYWRIGHT);
    const { run, runner } = factory(target, writesGreetingAndTest, {
      verifier: () => ({ kind: "plan-limit", message: "weekly limit reached", resetsAt: RESETS_AT }),
    });

    const report = await run();

    expect(report.result).toBe("paused");
    expect(report.log.pauseReason).toBe("the plan limit of opencode was reached: weekly limit reached");
    expect(report.log.resetsAt).toBe(RESETS_AT.toISOString());
    expect(report.log.subtasks[0]).toMatchObject({ state: "pending", verifierRejections: 0, gateRejections: 0 });
    expect(runner.workers.filter((worker) => worker.attempts.length > 0).map((worker) => worker.attempts.length)).toEqual([1]);
  });
});
