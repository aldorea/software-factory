import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActivityEvent } from "../../src/workers/types.ts";
import {
  passingTester,
  testerReport,
  type AttemptScript,
  type FakeWorkerRecord,
  type TesterScript,
} from "../fakes/worker-runner.ts";
import { git, harness, ISSUE, specText, targetRepo, temp } from "./harness.ts";

afterEach(() => temp.removeAll());

const ISSUE_BODY = [
  "## What to build",
  "",
  "Two parts.",
  "",
  "## Acceptance criteria",
  "",
  "- [ ] A1 The first part works.",
  "- [ ] A2 The second part works with the first.",
  "- [ ] A3 The parts look tidy.",
  "",
].join("\n");

const SPEC = specText({
  files: { A1: ["a/"], A2: ["b/"], A3: ["b/"] },
  base: null,
  subtasks: [
    { id: "S1", criteria: ["A1"], scope: ["a/", "ok-A1"], dependsOn: [], testChanges: [] },
    { id: "S2", criteria: ["A2", "A3"], scope: ["b/", "ok-A2"], dependsOn: [], testChanges: [] },
  ],
  criteria: {
    A1: { evidence: "request", level: "subtask" },
    A2: { evidence: "request", level: "integration" },
    A3: { evidence: "human", level: "integration", reason: "Tidiness is subjective" },
  },
});

const CONFIG = `
export default {
  image: "greeting-worker:dev",
  checks: [{ name: "parts", command: "test -e a/a.txt" }],
  evidence: { request: "test -e ok-{{id}}" },
  environment: ({ purpose, slot }) => ({ DATABASE_URL: "postgres://neon/" + purpose, E2E_PORT: String(4000 + slot) }),
  protectedPaths: ["package.json"],
  roles: {
    workers: { agent: "claude-code", model: "sonnet" },
    verifier: { agent: "opencode", model: "opencode-go/kimi-k2" },
    tester: { agent: "claude-code", model: "opus" },
  },
};
`;

function target() {
  return targetRepo({ config: CONFIG, issueBody: ISSUE_BODY, spec: SPEC });
}

const subtaskOf = (call: { spec: { id: string } }) => call.spec.id.replace(`${ISSUE}-`, "");

const bothParts: AttemptScript = (call) => {
  if (call.spec.id.includes("followup")) return { files: { "b/fixed.txt": `${call.spec.id}\n` }, commit: "Fix the second part" };
  if (subtaskOf(call) === "S1") return { files: { "a/a.txt": "a\n", "ok-A1": "ok\n" }, commit: "Part one" };
  return { files: { "b/b.txt": "b\n", "ok-A2": "ok\n" }, commit: "Part two" };
};

const secondPartLate: AttemptScript = (call) => {
  if (call.spec.id.includes("followup")) return { files: { "ok-A2": "ok\n" }, commit: "Fix the second criterion" };
  if (subtaskOf(call) === "S1") return { files: { "a/a.txt": "a\n", "ok-A1": "ok\n" }, commit: "Part one" };
  return { files: { "b/b.txt": "b\n" }, commit: "Part two" };
};

const testers = (runner: { workers: FakeWorkerRecord[] }) => runner.workers.filter((worker) => worker.spec.id.endsWith("-tester"));
const followUps = (runner: { workers: FakeWorkerRecord[] }) => runner.workers.filter((worker) => /-followup-\d+$/.test(worker.spec.id));

const failsSecondOnce: TesterScript = (call) => {
  if (call.number > 1 || !call.spec.id.endsWith("-verification-tester")) return passingTester(call);
  return {
    evidence: { "A1/steps.txt": "curl /a\n200 OK\n", "A2/steps.txt": "curl /b\nthe page said bye\n" },
    outcome: testerReport([
      { id: "A1", verdict: "pass", observation: "The first part answered.", evidence: ["A1/steps.txt"] },
      { id: "A2", verdict: "fail", observation: "The second part said bye instead of hello.", evidence: ["A2/steps.txt"] },
    ]),
  };
};

describe("factory run: the acceptance tester", () => {
  it("should report the activity of the tester with the prefix tester, in order, and leave the run log as it is without activity", async () => {
    const withActivity = async (events: ActivityEvent[]) => {
      const repo = await target();
      const { run, activity } = harness(repo, bothParts, {}, (call) => ({ ...passingTester(call), activity: events }));
      const report = await run();
      return { activity, report };
    };

    const talkative = await withActivity([
      { kind: "tool", tool: "Navigate", target: "/login" },
      { kind: "message", text: "The login page answers." },
      { kind: "end", outcome: "completed" },
    ]);
    const quiet = await withActivity([]);

    expect(talkative.activity.map((entry) => [entry.source, entry.event])).toEqual([
      ["tester", { kind: "tool", tool: "Navigate", target: "/login" }],
      ["tester", { kind: "message", text: "The login page answers." }],
      ["tester", { kind: "end", outcome: "completed" }],
    ]);
    expect(talkative.activity.every((entry) => entry.at.getTime() === new Date("2026-10-24T08:00:00.000Z").getTime())).toBe(true);
    expect(quiet.activity).toEqual([]);
    expect(talkative.report.result).toBe(quiet.report.result);
    expect(talkative.report.log.verification?.tester).toEqual(quiet.report.log.verification?.tester);
  });

  it("should give the tester the text of every Playwright and request criterion of the run, and never a human one", async () => {
    const repo = await target();
    const { run, runner } = harness(repo, bothParts);

    await run();

    const [tester] = testers(runner);
    const prompt = tester?.attempts[0]?.prompt ?? "";
    expect(prompt).toContain("- A1 (request): The first part works.");
    expect(prompt).toContain("- A2 (request): The second part works with the first.");
    expect(prompt).not.toContain("A3");
    expect(prompt).not.toContain("tidy");
    expect(tester?.attempts[0]?.agent).toEqual({ kind: "claude-code", model: "opus" });
  });

  it("should run the tester in a container of its own on the verified SHA, with its own environment and an evidence folder outside the worktree", async () => {
    const repo = await target();
    const { run, runner } = harness(repo, bothParts);

    const report = await run();

    const [tester] = testers(runner);
    expect(tester?.spec.env).toEqual({ DATABASE_URL: "postgres://neon/tester", E2E_PORT: "4000", CLAUDE_CODE_OAUTH_TOKEN: "token-of-the-host" });
    expect(tester?.spec.baseRef).toBe(`factory-check/${report.log.runId}/verification-tester`);
    expect(tester?.spec.outputDir).toBeDefined();
    expect(relative(tester?.worktreePath ?? "", tester?.spec.outputDir ?? "").startsWith("..")).toBe(true);
    expect(tester?.attempts[0]?.prompt).toContain(tester?.spec.outputDir ?? "");
    expect(tester?.closed).toBe(true);
    expect(report.result).toBe("ready");
  });

  it("should run the tester only in a round whose checks and automatic criteria pass", async () => {
    const repo = await target();
    const { run, runner } = harness(repo, secondPartLate);

    const report = await run();

    expect(followUps(runner)).toHaveLength(1);
    expect(testers(runner).map((worker) => worker.spec.id)).toEqual([`${report.log.runId}-verification-2-tester`]);
    expect(report.result).toBe("ready");
  });

  it("should send a follow-up to the subtask that owns a criterion the tester fails, with its observation, the paths and the end of its evidence", async () => {
    const repo = await target();
    const { run, runner } = harness(repo, bothParts, {}, failsSecondOnce);

    const report = await run();

    const [followUp] = followUps(runner);
    expect(followUps(runner)).toHaveLength(1);
    expect(followUp?.spec.id).toBe(`${ISSUE}-S2-followup-1`);
    const prompt = followUp?.attempts[0]?.prompt ?? "";
    expect(prompt).toContain("criterion A2 (request) passed its command, but the acceptance tester, using the running app, failed it");
    expect(prompt).toContain("The second part works with the first");
    expect(prompt).toContain("The tester saw: The second part said bye instead of hello.");
    expect(prompt).toContain("`tester/verification/A2/steps.txt`");
    expect(prompt).toContain("curl /b\nthe page said bye");
    expect(prompt).not.toContain("A1/steps.txt");
    expect(testers(runner)).toHaveLength(2);
    expect(report.result).toBe("ready");
  });

  it("should test every automatic criterion again after a follow-up, not only the one it failed", async () => {
    const repo = await target();
    const { run, runner } = harness(repo, bothParts, {}, failsSecondOnce);

    await run();

    const second = testers(runner)[1]?.attempts[0]?.prompt ?? "";
    expect(second).toContain("- A1 (request)");
    expect(second).toContain("- A2 (request)");
  });

  it("should record in run.json the criteria the tester failed while their command passed, and count them as friction", async () => {
    const repo = await target();
    const { run } = harness(repo, bothParts, {}, failsSecondOnce);

    const report = await run();

    expect(report.log.testerFailures).toEqual([
      { sha: expect.stringMatching(/^[0-9a-f]{40}$/), criterion: "A2", observation: "The second part said bye instead of hello." },
    ]);
    expect(report.log.friction.testerRejections).toBe(1);
  });

  it("should block the owner by patience when the tester keeps failing the same criterion after each follow-up", async () => {
    const repo = await target();
    const alwaysFails: TesterScript = (call) => ({
      evidence: { "A1/s.txt": "ok\n", "A2/s.txt": "bye\n" },
      outcome: testerReport([
        { id: "A1", verdict: "pass", observation: "fine", evidence: ["A1/s.txt"] },
        { id: "A2", verdict: "fail", observation: `still bye ${call.spec.id}`, evidence: ["A2/s.txt"] },
      ]),
    });
    const { run, runner } = harness(repo, bothParts, {}, alwaysFails);

    const report = await run();

    expect(report.result).toBe("draft");
    expect(report.log.subtasks.find((subtask) => subtask.id === "S2")).toMatchObject({ state: "blocked", blockType: "patience" });
    expect(followUps(runner)).toHaveLength(2);
    expect(report.log.verification?.passed).toBe(false);
  });

  it.each([
    [
      "with no verdict for a criterion",
      { evidence: { "A1/s.txt": "ok\n" }, outcome: testerReport([{ id: "A1", verdict: "pass", observation: "fine", evidence: ["A1/s.txt"] }]) },
      "the report gives no verdict for A2",
    ],
    [
      "with an evidence path that does not exist",
      {
        evidence: { "A1/s.txt": "ok\n" },
        outcome: testerReport([
          { id: "A1", verdict: "pass", observation: "fine", evidence: ["A1/s.txt"] },
          { id: "A2", verdict: "pass", observation: "fine", evidence: ["A2/shot.png"] },
        ]),
      },
      "the evidence A2/shot.png of A2 is not a file in the evidence folder",
    ],
    [
      "that ends in an agent error, as a plan limit of OpenCode Go does until its error is observed",
      { outcome: { kind: "agent-error" as const, message: "quota exceeded", exitCode: 1 } },
      "The acceptance tester failed with exit code 1: quota exceeded",
    ],
  ])("should count a tester answer %s as an error of the tester, send no follow-up and leave the pull request a draft", async (_, answer, problem) => {
    const repo = await target();
    const { run, runner } = harness(repo, bothParts, {}, () => answer);

    const report = await run();

    expect(report.result).toBe("draft");
    expect(report.log.verification?.passed).toBe(false);
    expect(report.log.verification?.tester?.error).toContain(problem);
    expect(followUps(runner)).toEqual([]);
    const pullRequest = repo.github.pullRequests[0];
    expect(pullRequest?.draft).toBe(true);
    expect(pullRequest?.body).toContain("the acceptance tester gave no usable verdict");
    expect(pullRequest?.body).toContain(problem);
  });

  it("should refuse a symlink as evidence and never copy its target, because the target is a file of the host", async () => {
    const repo = await target();
    const secret = join(await temp.make("host-secret-"), "id_rsa");
    await writeFile(secret, "PRIVATE KEY OF THE HOST\n");
    const linksSecret: TesterScript = () => ({
      evidence: { "A1/s.txt": "ok\n" },
      links: { "A2/out.txt": secret },
      outcome: testerReport([
        { id: "A1", verdict: "pass", observation: "fine", evidence: ["A1/s.txt"] },
        { id: "A2", verdict: "fail", observation: "bye", evidence: ["A2/out.txt"] },
      ]),
    });
    const { run, runner } = harness(repo, bothParts, {}, linksSecret);

    const report = await run();

    expect(report.log.verification?.tester?.error).toContain("the evidence A2/out.txt of A2 is not a file in the evidence folder");
    expect(followUps(runner)).toEqual([]);
    const runDir = join(repo.repoDir, ".factory", "logs", report.log.runId);
    expect(existsSync(join(runDir, "tester", "verification", "A2", "out.txt"))).toBe(false);
    expect(existsSync(join(runDir, "tester", "verification", "A1", "s.txt"))).toBe(true);
    expect(repo.github.pullRequests[0]?.body).not.toContain("PRIVATE KEY");
  });

  it("should keep the evidence the tester left in the run log when its report is unusable, so the developer can see why", async () => {
    const repo = await target();
    const { run } = harness(repo, bothParts, {}, () => ({ evidence: { "A1/steps.txt": "curl /a\n" }, outcome: { kind: "completed", summary: "All good." } }));

    const report = await run();

    expect(report.log.verification?.tester?.error).toContain("the report has no json block");
    expect(await readFile(join(repo.repoDir, ".factory", "logs", report.log.runId, "tester", "verification", "A1", "steps.txt"), "utf8")).toBe(
      "curl /a\n",
    );
  });

  it("should pause the run, not fail it, when the tester reaches the plan limit of its agent", async () => {
    const repo = await target();
    const { run } = harness(repo, bothParts, {}, () => ({ outcome: { kind: "plan-limit", message: "weekly limit reached" } }));

    const report = await run();

    expect(report.result).toBe("paused");
    expect(report.log.pauseReason).toBe("the plan limit of claude-code was reached: weekly limit reached");
    expect(report.log.pauses?.map((pause) => pause.agent)).toEqual(["claude-code"]);
    expect(report.log.criteria.passing).toEqual([]);
  });

  it("should record the tokens of the tester per agent in run.json, apart from the attempts of the subtasks", async () => {
    const repo = await target();
    const counted: TesterScript = (call) => ({ ...passingTester(call), usage: { inputTokens: 300, outputTokens: 30 } });
    const { run } = harness(repo, bothParts, {}, counted);

    const report = await run();

    expect(report.log.testerUsage).toEqual({ "claude-code": { inputTokens: 300, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 30 } });
    expect(report.log.subtasks.every((subtask) => subtask.usage.inputTokens === 0)).toBe(true);
    expect(report.log.cost.perAgent["claude-code"]?.inputTokens).toBe(300);
  });
});

describe("factory run: the acceptance tester in the pull request", () => {
  const withScreenshot: TesterScript = (call) => ({
    evidence: { "A1/steps.txt": "curl /a\n", "A1/shot.png": "png-of-a", "A2/steps.txt": "curl /b\n" },
    outcome: testerReport([
      { id: "A1", verdict: "pass", observation: "The first part answered.", evidence: ["A1/steps.txt", "A1/shot.png"] },
      { id: "A2", verdict: "pass", observation: "The second part said hello.", evidence: ["A2/steps.txt"] },
    ]),
  });

  it("should show, for each automatic criterion, the result of its command and the observation of the tester with links to its evidence", async () => {
    const repo = await target();
    const { run } = harness(repo, bothParts, {}, withScreenshot);

    const report = await run();

    const body = repo.github.pullRequests[0]?.body ?? "";
    const commit = report.log.evidence?.commit ?? "";
    const base = `https://github.test/aldorea/greeting/blob/${commit}/${report.log.runId}/tester/verification`;
    expect(body).toContain("- [x] A1 The first part works. Evidence: request `test -e ok-A1`");
    expect(body).toContain(
      `  Acceptance tester: passed. The first part answered. Evidence: [steps.txt](${base}/A1/steps.txt), [shot.png](${base}/A1/shot.png)`,
    );
    expect(body).toContain(`  ![shot.png](${base}/A1/shot.png?raw=true)`);
    expect(body).toContain(`  Acceptance tester: passed. The second part said hello. Evidence: [steps.txt](${base}/A2/steps.txt)`);
  });

  it("should push the evidence of the tester to the evidence branch, next to the attachments of the human criteria", async () => {
    const repo = await target();
    const { run } = harness(repo, bothParts, {}, withScreenshot);

    const report = await run();

    const folder = `${report.log.runId}/tester/verification`;
    expect(await git(repo.remoteDir, "show", `factory-evidence/42:${folder}/A1/shot.png`)).toBe("png-of-a");
    expect(await git(repo.remoteDir, "show", `factory-evidence/42:${folder}/A2/steps.txt`)).toBe("curl /b");
  });

  it("should keep the folders of the tester's evidence on the evidence branch, so two screenshots with the same name do not overwrite each other", async () => {
    const repo = await target();
    const twoSteps: TesterScript = () => ({
      evidence: { "A1/step1/shot.png": "first", "A1/step2/shot.png": "second", "A2/s.txt": "ok\n" },
      outcome: testerReport([
        { id: "A1", verdict: "pass", observation: "fine", evidence: ["A1/step1/shot.png", "A1/step2/shot.png"] },
        { id: "A2", verdict: "pass", observation: "fine", evidence: ["A2/s.txt"] },
      ]),
    });
    const { run } = harness(repo, bothParts, {}, twoSteps);

    const report = await run();

    const folder = `${report.log.runId}/tester/verification/A1`;
    expect(await git(repo.remoteDir, "show", `factory-evidence/42:${folder}/step1/shot.png`)).toBe("first");
    expect(await git(repo.remoteDir, "show", `factory-evidence/42:${folder}/step2/shot.png`)).toBe("second");
    expect(repo.github.pullRequests[0]?.body).toContain(`${folder}/step2/shot.png`);
  });

  it("should uncheck a criterion the tester failed although its command passed, and show both proofs", async () => {
    const repo = await target();
    const fails: TesterScript = () => ({
      evidence: { "A1/s.txt": "ok\n", "A2/s.txt": "bye\n" },
      outcome: testerReport([
        { id: "A1", verdict: "pass", observation: "fine", evidence: ["A1/s.txt"] },
        { id: "A2", verdict: "fail", observation: "It said bye.", evidence: ["A2/s.txt"] },
      ]),
    });
    const { run } = harness(repo, bothParts, {}, fails);

    await run();

    const body = repo.github.pullRequests[0]?.body ?? "";
    expect(body).toContain("- [ ] A2 The second part works with the first. Evidence: request `test -e ok-A2` passed");
    expect(body).toContain("  Acceptance tester: failed. It said bye. Evidence: [s.txt]");
    expect(body).toContain("criteria not passing: A2");
  });
});
