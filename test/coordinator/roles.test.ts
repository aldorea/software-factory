import { afterEach, describe, expect, it } from "vitest";
import type { RoleChoice } from "../../src/config/config.ts";
import { runIssue, type RunRequest } from "../../src/coordinator/run.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeVerifier } from "../fakes/verifier.ts";
import { FakeWorkerRunner, type AttemptScript } from "../fakes/worker-runner.ts";
import { CONFIG, ISSUE, ISSUE_BODY, specText, targetRepo, temp, TOKEN, writesHello, type Target } from "./harness.ts";

afterEach(() => temp.removeAll());

const KEY = "key-of-the-host";
const SONNET: RoleChoice = { agent: "claude-code", model: "sonnet" };
const OPUS: RoleChoice = { agent: "claude-code", model: "opus" };
const KIMI: RoleChoice = { agent: "opencode", model: "opencode-go/kimi-k2" };
const GLM: RoleChoice = { agent: "opencode", model: "opencode-go/glm-4.6" };

const NO_ROLES = CONFIG.replace(/  roles: \{[\s\S]*?\n  \},\n/, "");

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
  ).replace('evidence: { request: "grep -q hello src/greeting.txt # {{id}}" }', 'evidence: { request: "true # {{id}}" }'),
};

function factory(
  target: Target,
  script: AttemptScript,
  options: { at?: string; roles?: RunRequest["roles"]; credentials?: RunRequest["credentials"] } = {},
) {
  const runner = new FakeWorkerRunner(script);
  const verifier = new FakeVerifier();
  const clock = new FakeClock(options.at ?? "2026-10-24T08:00:00.000Z");
  const request: RunRequest = {
    repoDir: target.repoDir,
    issue: ISSUE,
    credentials: options.credentials ?? { "claude-code": TOKEN, opencode: KEY },
    ...(options.roles ? { roles: options.roles } : {}),
  };
  const run = () => runIssue(request, { runner, verifier, github: target.github, notifier: new FakeNotifier(), clock });
  return { runner, verifier, clock, run };
}

const writesGreetingAndTest: AttemptScript = () => ({
  files: { "src/greeting.txt": "hello\n", "tests/greeting.spec.ts": 'test("A1 says hello", () => {});\n' },
});

describe("factory run: the agent of each role is checked before the run starts", () => {
  it("should stop before any worker starts when the verifier the run will ask has no credential on the host", async () => {
    const target = await targetRepo(WITH_PLAYWRIGHT);
    const { run, runner } = factory(target, writesGreetingAndTest, { credentials: { "claude-code": TOKEN } });

    await expect(run()).rejects.toThrow("OPENCODE_API_KEY is not set; the opencode verifier needs it");
    expect(runner.workers).toEqual([]);
  });

  it("should not need the credential of the verifier when no criterion of the spec asks it", async () => {
    const target = await targetRepo();
    const { run } = factory(target, writesHello, { credentials: { "claude-code": TOKEN } });

    expect((await run()).result).toBe("ready");
  });

  it("should stop before any worker starts when the chosen model of a role is pay per use", async () => {
    const target = await targetRepo();
    const { run, runner } = factory(target, writesHello, { roles: { workers: { agent: "opencode", model: "opencode/kimi-k2" } } });

    await expect(run()).rejects.toThrow("the workers model must be an opencode-go/ model");
    expect(runner.workers).toEqual([]);
  });

  it("should refuse to start when neither the request nor the config gives the agent of a role", async () => {
    const target = await targetRepo({ config: NO_ROLES });
    const { run, runner } = factory(target, writesHello, { roles: { workers: SONNET } });

    await expect(run()).rejects.toThrow("no agent for the verifier");
    expect(runner.workers).toEqual([]);
  });

  it("should run the workers with the chosen agent and model over the config default", async () => {
    const target = await targetRepo({ config: NO_ROLES });
    const { run, runner } = factory(target, writesHello, { roles: { workers: OPUS, verifier: GLM, tester: KIMI } });

    const report = await run();

    expect(runner.workers[0]?.attempts[0]?.agent).toEqual({ kind: "claude-code", model: "opus" });
    expect(report.log.agents).toEqual({ workers: OPUS, verifier: GLM, tester: KIMI, changes: [] });
  });

  it("should run the acceptance tester with its own chosen agent and model, and only the credential of that agent", async () => {
    const target = await targetRepo();
    const { run, runner } = factory(target, writesHello, { roles: { tester: KIMI } });

    await run();

    const tester = runner.workers.find((worker) => worker.spec.id.endsWith("-tester"));
    expect(tester?.attempts[0]?.agent).toEqual({ kind: "opencode", model: "opencode-go/kimi-k2" });
    expect(tester?.spec.env.OPENCODE_API_KEY).toBe(KEY);
    expect(tester?.spec.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("should stop before any worker starts when the acceptance tester the run will ask has no credential on the host", async () => {
    const target = await targetRepo();
    const { run, runner } = factory(target, writesHello, { roles: { tester: KIMI }, credentials: { "claude-code": TOKEN } });

    await expect(run()).rejects.toThrow("OPENCODE_API_KEY is not set; the opencode tester needs it");
    expect(runner.workers).toEqual([]);
  });
});

describe("factory run: records of the agents", () => {
  it("should name the agent and the model of each role in the pull request", async () => {
    const target = await targetRepo();
    const { run } = factory(target, writesHello);

    await run();

    const body = target.github.pullRequests[0]?.body ?? "";
    expect(body).toContain("- Workers: claude-code, model sonnet");
    expect(body).toContain("- Independent verifier: opencode, model opencode-go/kimi-k2");
    expect(body).toContain("- Acceptance tester: claude-code, model opus");
    expect(body).not.toContain("same model as the workers");
  });

  it("should say in one line when the acceptance tester used the same model as the workers, because its independence then rests on its clean context alone", async () => {
    const target = await targetRepo();
    const { run } = factory(target, writesHello, { roles: { tester: SONNET } });

    await run();

    expect(target.github.pullRequests[0]?.body).toContain(
      "The acceptance tester used the same model as the workers: its independence rests on its clean context alone.",
    );
  });

  it("should record a change of agent or model on resume in run.json and the pull request", async () => {
    const target = await targetRepo();
    const first = factory(target, () => ({ outcome: { kind: "plan-limit", message: "limit" } }));
    expect((await first.run()).result).toBe("paused");

    const second = factory(target, writesHello, { at: "2026-10-24T14:00:00.000Z", roles: { workers: OPUS, verifier: GLM, tester: KIMI } });
    const resumed = await second.run();

    expect(resumed.log.agents).toEqual({
      workers: OPUS,
      verifier: GLM,
      tester: KIMI,
      changes: [
        { role: "workers", from: SONNET, to: OPUS, at: "2026-10-24T14:00:00.000Z" },
        { role: "verifier", from: KIMI, to: GLM, at: "2026-10-24T14:00:00.000Z" },
        { role: "tester", from: OPUS, to: KIMI, at: "2026-10-24T14:00:00.000Z" },
      ],
    });
    const body = target.github.pullRequests[0]?.body ?? "";
    expect(body).toContain("- On resume at 2026-10-24T14:00:00.000Z, the workers changed from claude-code, model sonnet to claude-code, model opus");
    expect(body).toContain("- On resume at 2026-10-24T14:00:00.000Z, the independent verifier changed from opencode, model opencode-go/kimi-k2 to opencode, model opencode-go/glm-4.6");
    expect(body).toContain("- On resume at 2026-10-24T14:00:00.000Z, the acceptance tester changed from claude-code, model opus to opencode, model opencode-go/kimi-k2");
  });
});

describe("factory run: the limits of each agent", () => {
  it("should apply the token limits of the workers' agent, not those of another agent", async () => {
    const target = await targetRepo({
      config: CONFIG.replace(
        "  roles:",
        '  agents: { "claude-code": { tokensPerSubtask: 5000 }, opencode: { tokensPerSubtask: 100 } },\n  roles:',
      ),
    });
    const { run, runner } = factory(target, (call) =>
      call.number < 2 ? { files: { "src/greeting.txt": "bye\n" }, usage: { outputTokens: 200 } } : { files: { "src/greeting.txt": "hello\n" } },
    );

    const report = await run();

    expect(report.result).toBe("ready");
    expect(runner.workers[0]?.attempts).toHaveLength(2);
  });

  it("should run the workers in parallel up to the maxParallel of their own agent", async () => {
    const target = await targetRepo({
      ...TWO_SUBTASKS,
      config: TWO_SUBTASKS.config.replace("  roles:", '  agents: { opencode: { maxParallel: 2 } },\n  roles:'),
    });
    let running = 0;
    let most = 0;
    const { run } = factory(target, async (call) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 100));
      running -= 1;
      return call.spec.branch.endsWith("/S1") ? { files: { "src/greeting.txt": "hello\n" } } : { files: { "lib/farewell.txt": "bye\n" } };
    });

    expect((await run()).result).toBe("ready");
    expect(most).toBe(1);
  });
});

describe("factory run: patience on resume", () => {
  it("should keep counting patience for a subtask blocked before the pause, instead of giving it a fresh loop", async () => {
    const target = await targetRepo(TWO_SUBTASKS);
    const first = factory(target, (call) =>
      call.spec.branch.endsWith("/S1")
        ? { files: { "src/greeting.txt": `BAD ${call.number}\n` } }
        : { outcome: { kind: "plan-limit", message: "limit" } },
    );
    const paused = await first.run();
    expect(paused.result).toBe("paused");
    expect(paused.log.subtasks[0]?.block?.type).toBe("patience");

    const second = factory(
      target,
      (call) => (call.spec.branch.endsWith("/S1") ? { files: { "src/greeting.txt": "hello\n" } } : { files: { "lib/farewell.txt": "bye\n" } }),
      { at: "2026-10-24T14:00:00.000Z" },
    );
    const resumed = await second.run();

    expect(second.runner.workers.filter((worker) => worker.spec.branch.endsWith("/S1")).flatMap((worker) => worker.attempts)).toEqual([]);
    expect(resumed.log.subtasks.map((subtask) => [subtask.id, subtask.state, subtask.attempts.length])).toEqual([
      ["S1", "blocked", 3],
      ["S2", "merged", 2],
    ]);
    expect(resumed.log.subtasks[0]?.block).toMatchObject({ type: "patience", lastFailure: expect.stringContaining("parts") });
  });
});
