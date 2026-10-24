import { afterEach, describe, expect, it } from "vitest";
import { runIssue } from "../../src/coordinator/run.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeVerifier, type VerifierScript } from "../fakes/verifier.ts";
import { FakeWorkerRunner, type AttemptCall, type AttemptScript } from "../fakes/worker-runner.ts";
import { BRANCH, CONFIG, git, harness, ISSUE, ISSUE_BODY, specText, targetRepo, temp, TOKEN, type Target } from "./harness.ts";

afterEach(() => temp.removeAll());

const RESETS_AT = new Date("2026-10-24T13:00:00.000Z");
const HOUR = 60 * 60 * 1000;

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

describe("factory run on a paused or partially done run", () => {
  const isS1 = (call: AttemptCall) => call.spec.branch.endsWith("/S1");
  const working = (runner: FakeWorkerRunner) => runner.workers.filter((worker) => worker.attempts.length > 0);

  it("should skip the merged subtasks, reuse the existing subtask branch and update the same pull request", async () => {
    const target = await targetRepo(TWO_SUBTASKS);
    const first = factory(target, (call) => {
      if (isS1(call)) return { files: { "src/greeting.txt": "hello\n" } };
      if (call.number === 1) return { files: { "lib/farewell.txt": "BAD\n" }, commit: "First farewell" };
      return { outcome: { kind: "plan-limit", message: "5-hour limit reached", resetsAt: RESETS_AT } };
    });
    const paused = await first.run();
    expect(paused.result).toBe("paused");
    const s2Branch = paused.log.subtasks[1]?.branch ?? "";

    let resumedFrom = "";
    const second = factory(
      target,
      async (call) => {
        resumedFrom = await git(target.repoDir, "log", "-1", "--format=%s", s2Branch);
        return { files: { "lib/farewell.txt": "bye\n" } };
      },
      { at: "2026-10-24T13:30:00.000Z" },
    );
    const resumed = await second.run();

    expect(resumed.result).toBe("ready");
    expect(working(second.runner).map((worker) => worker.spec.branch)).toEqual([s2Branch]);
    expect(resumedFrom).toBe("First farewell");
    expect(resumed.log.runId).toBe(paused.log.runId);
    expect(resumed.log.subtasks.map((subtask) => [subtask.id, subtask.state, subtask.attempts.length])).toEqual([
      ["S1", "merged", 1],
      ["S2", "merged", 3],
    ]);
    expect(new Set(resumed.log.subtasks[1]?.attempts.map((attempt) => attempt.logPath)).size).toBe(3);
    expect(resumed.log).not.toHaveProperty("pauseReason");
    expect(resumed.log).not.toHaveProperty("resetsAt");
    expect(target.github.pullRequests).toHaveLength(1);
    expect(target.github.pullRequests[0]).toMatchObject({ draft: false });
    expect(await git(target.repoDir, "log", "--merges", "--format=%s", BRANCH)).toBe(
      ["Merge subtask S2 of #42", "Merge subtask S1 of #42"].join("\n"),
    );
  });

  it("should skip the subtasks merged by an earlier draft run and start the others with fresh patience", async () => {
    const target = await targetRepo(TWO_SUBTASKS);
    const first = factory(target, (call) =>
      isS1(call) ? { files: { "src/greeting.txt": "hello\n" } } : { files: { "lib/farewell.txt": `BAD ${call.number}\n` } },
    );
    const draft = await first.run();
    expect(draft.result).toBe("draft");
    expect(draft.log.subtasks[1]?.block?.type).toBe("patience");

    const second = factory(target, () => ({ files: { "lib/farewell.txt": "bye\n" } }), { at: "2026-10-24T09:00:00.000Z" });
    const rerun = await second.run();

    expect(rerun.result).toBe("ready");
    expect(rerun.log.runId).not.toBe(draft.log.runId);
    expect(working(second.runner).map((worker) => worker.spec.branch)).toEqual([draft.log.subtasks[1]?.branch]);
    expect(rerun.log.subtasks.map((subtask) => [subtask.id, subtask.state, subtask.attempts.length])).toEqual([
      ["S1", "merged", 0],
      ["S2", "merged", 1],
    ]);
  });

  it("should count neither the time in pause against the run wall clock nor the plan limit against patience", async () => {
    const target = await targetRepo();
    const first = factory(target, (call) => {
      first.clock.advance(HOUR / 3);
      return call.number < 3 ? { files: { "src/greeting.txt": `bye ${call.number}\n` } } : { outcome: { kind: "plan-limit", message: "limit" } };
    });
    await first.run();

    const second = factory(
      target,
      () => {
        second.clock.advance(HOUR / 3);
        return { files: { "src/greeting.txt": "bye again\n" } };
      },
      { at: "2026-10-24T14:30:00.000Z" },
    );
    const resumed = await second.run();

    expect(working(second.runner).map((worker) => worker.attempts.length)).toEqual([1]);
    expect(resumed.log.subtasks[0]?.block?.type).toBe("patience");
    expect(resumed.log.cost.pausedMs).toBe(5.5 * HOUR);
    expect(resumed.log.cost.wallClockMs).toBe((4 / 3) * HOUR);
  });

  it("should count the work of a subtask before the pause against its own wall clock", async () => {
    const target = await targetRepo();
    const first = factory(target, (call) => {
      first.clock.advance(HOUR);
      return call.number < 2 ? { files: { "src/greeting.txt": "bye\n" } } : { outcome: { kind: "plan-limit", message: "limit" } };
    });
    await first.run();

    const second = factory(target, () => ({ files: { "src/greeting.txt": "hello\n" } }), { at: "2026-10-24T15:00:00.000Z" });
    const resumed = await second.run();

    expect(working(second.runner)).toHaveLength(0);
    expect(resumed.log.subtasks[0]?.block?.type).toBe("subtask-wall-clock");
  });

  it("should keep the scope extended before the pause, in the gate and in the prompt", async () => {
    const target = await targetRepo();
    const first = factory(target, (call) =>
      call.number === 1
        ? { outcome: { kind: "completed", summary: "FACTORY-SCOPE-REQUEST: docs/greeting.md" } }
        : { outcome: { kind: "plan-limit", message: "limit" } },
    );
    await first.run();

    const second = factory(target, () => ({ files: { "src/greeting.txt": "hello\n", "docs/greeting.md": "# Hello\n" } }), {
      at: "2026-10-24T14:00:00.000Z",
    });
    const resumed = await second.run();

    expect(resumed.result).toBe("ready");
    expect(resumed.log.subtasks[0]?.scopeExtensions).toEqual(["docs/greeting.md"]);
    expect(working(second.runner)[0]?.attempts[0]?.prompt).toContain("docs/greeting.md");
  });
});
