import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approveSpec } from "../../src/commands/approve.ts";
import { runIssue } from "../../src/coordinator/run.ts";
import type { RunLog } from "../../src/coordinator/run-log.ts";
import type { VerifierAnswer, VerifierQuestion } from "../../src/coordinator/verifier.ts";
import { revParse } from "../../src/workers/git.ts";
import { execOk } from "../../src/workers/sh.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeGitHub } from "../fakes/github.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeVerifier } from "../fakes/verifier.ts";
import { FakeWorkerRunner, type AttemptScript } from "../fakes/worker-runner.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

const ISSUE = 7;
const BRANCH = "factory/7-greeting";

const ISSUE_BODY = [
  "## What to build",
  "",
  "A greeting.",
  "",
  "## Acceptance criteria",
  "",
  "- [ ] A1 The greeting page says hello.",
  "- [ ] A2 The greeting file contains hello.",
  "",
].join("\n");

const SPEC = [
  "# Spec #7",
  "",
  "```json factory-spec",
  JSON.stringify(
    {
      files: { A1: ["tests/greeting.spec.ts"], A2: ["src/greeting.txt"] },
      base: null,
      subtasks: [{ id: "S1", criteria: ["A1", "A2"], scope: ["src/", "tests/"], dependsOn: [], testChanges: [] }],
      criteria: { A1: { evidence: "playwright", level: "subtask" }, A2: { evidence: "request", level: "subtask" } },
    },
    null,
    2,
  ),
  "```",
  "",
].join("\n");

const CONFIG = `
export default {
  image: "greeting-worker:dev",
  checks: [{ name: "greeting", command: "grep -q hello src/greeting.txt" }],
  evidence: {
    playwright: "grep -q hello src/greeting.txt # {{id}}",
    request: "grep -q hello src/greeting.txt # {{id}}",
  },
  environment: () => ({}),
  protectedPaths: ["package.json"],
  roles: {
    workers: { agent: "claude-code", model: "sonnet" },
    verifier: { agent: "opencode", model: "opencode-go/kimi-k2" },
  },
};
`;

const TEST_SOURCE = [
  'import { test, expect } from "@playwright/test";',
  "",
  'test("A1 the greeting page says hello", async ({ page }) => {',
  '  await page.goto("/");',
  '  await expect(page.getByText("hello")).toBeVisible();',
  "});",
  "",
].join("\n");

async function git(dir: string, ...args: string[]): Promise<string> {
  return (await execOk("git", ["-C", dir, ...args])).trim();
}

interface Target {
  repoDir: string;
  remoteDir: string;
  github: FakeGitHub;
}

async function targetRepo(): Promise<Target> {
  const repoDir = await temp.make("verifier-target-");
  const remoteDir = await temp.make("verifier-remote-");
  await execOk("git", ["init", "-q", "--bare", "-b", "main", remoteDir]);
  await execOk("git", ["init", "-q", "-b", "main", repoDir]);
  await git(repoDir, "config", "user.name", "t");
  await git(repoDir, "config", "user.email", "t@t");
  await git(repoDir, "remote", "add", "origin", remoteDir);
  await writeFile(join(repoDir, "README.md"), "# greeting\n");
  await writeFile(join(repoDir, ".gitignore"), ".factory/logs/\n.factory/worktrees/\n");
  await mkdir(join(repoDir, ".factory"));
  await writeFile(join(repoDir, ".factory", "config.ts"), CONFIG);
  await git(repoDir, "add", ".");
  await git(repoDir, "commit", "-q", "-m", "init");
  await git(repoDir, "push", "-q", "origin", "main");
  await git(repoDir, "switch", "-q", "-c", BRANCH);
  await mkdir(join(repoDir, "specs"));
  await writeFile(join(repoDir, "specs", "7.md"), SPEC);
  await git(repoDir, "add", ".");
  await git(repoDir, "commit", "-q", "-m", "Spec #7");
  await git(repoDir, "switch", "-q", "main");
  const github = new FakeGitHub([{ number: ISSUE, title: "Greeting", body: ISSUE_BODY }]);
  await approveSpec({ repoDir, issue: ISSUE, github, protectedPaths: ["package.json"], now: new Date("2026-10-24T07:00:00Z") });
  return { repoDir, remoteDir, github };
}

function harness(
  target: Target,
  script: AttemptScript,
  answer: (question: VerifierQuestion) => VerifierAnswer = () => ({ kind: "accept" }),
) {
  const runner = new FakeWorkerRunner(script);
  const verifier = new FakeVerifier(answer);
  const run = () =>
    runIssue(
      { repoDir: target.repoDir, issue: ISSUE, credentials: { "claude-code": "token-of-the-host" } },
      { runner, verifier, github: target.github, notifier: new FakeNotifier(), clock: new FakeClock("2026-10-24T08:00:00.000Z") },
    );
  return { runner, verifier, run };
}

const writesGreetingAndTest: AttemptScript = () => ({
  files: { "src/greeting.txt": "hello\n", "tests/greeting.spec.ts": TEST_SOURCE },
  commit: "Write the greeting and its test",
});

async function readRunLog(path: string): Promise<RunLog> {
  return JSON.parse(await readFile(path, "utf8")) as RunLog;
}

describe("the independent verifier at the gate", () => {
  it("should ask the verifier about each Playwright criterion with only its text and its test, and merge when it accepts", async () => {
    const target = await targetRepo();
    const { run, verifier } = harness(target, writesGreetingAndTest);

    const report = await run();

    expect(verifier.questions).toEqual([
      {
        id: "A1",
        criterion: "A1 The greeting page says hello.",
        test: TEST_SOURCE,
        logPath: expect.stringContaining(join(".factory", "logs", report.log.runId)),
      },
    ]);
    expect(report.log.subtasks[0]?.state).toBe("merged");
    expect(report.result).toBe("ready");
    expect(await revParse(target.repoDir, BRANCH)).not.toBe(await revParse(target.repoDir, "main"));
    expect((await readRunLog(report.runLogPath)).subtasks[0]?.gate?.verifier).toEqual([
      { id: "A1", verdict: "accept", logPath: verifier.questions[0]?.logPath },
    ]);
  });

  it("should feed the reason of the verifier to the next attempt and merge once the verifier accepts the new test", async () => {
    const target = await targetRepo();
    const weak = 'test("A1 the greeting page says hello", async () => { expect(1).toBe(1); });\n';
    const { run, runner } = harness(
      target,
      (call) => ({
        files: { "src/greeting.txt": "hello\n", "tests/greeting.spec.ts": call.number === 1 ? weak : TEST_SOURCE },
        commit: `Attempt ${call.number}`,
      }),
      (question) => (question.test === weak ? { kind: "refute", reason: "Asserts nothing about the page." } : { kind: "accept" }),
    );

    const report = await run();

    expect(runner.workers[0]?.attempts[1]?.prompt).toContain("the verifier refuted the test of A1: Asserts nothing about the page.");
    expect(report.log.subtasks[0]).toMatchObject({ state: "merged", verifierRejections: 1, gateRejections: 0 });
    expect(report.log.friction).toMatchObject({ verifierRejections: 1, gateRejections: 0 });
    expect(report.result).toBe("ready");
  });

  it("should block the subtask by patience, without merging it, when the verifier keeps refuting the test", async () => {
    const target = await targetRepo();
    const integrationBefore = await revParse(target.repoDir, BRANCH);
    const { run, verifier } = harness(target, writesGreetingAndTest, () => ({ kind: "refute", reason: "Asserts nothing." }));

    const report = await run();

    expect(verifier.questions).toHaveLength(3);
    expect(report.log.subtasks[0]).toMatchObject({ state: "blocked", blockType: "patience", verifierRejections: 3, gateRejections: 0 });
    expect(report.log.subtasks[0]?.reason).toContain("verifier:A1:refute");
    expect(await revParse(target.repoDir, BRANCH)).toBe(integrationBefore);
    expect(report.result).toBe("draft");
    expect(target.github.pullRequests[0]?.draft).toBe(true);
  });

  it("should record a refutation in run.json apart from the other rejections of the gate", async () => {
    const target = await targetRepo();
    const { run } = harness(target, writesGreetingAndTest, () => ({ kind: "refute", reason: "Asserts nothing." }));

    const report = await run();

    const log = await readRunLog(report.runLogPath);
    const gate = log.subtasks[0]?.gate;
    expect(gate).toMatchObject({ accepted: false, reasons: [] });
    expect(gate?.verifier).toEqual([
      { id: "A1", verdict: "refute", reason: "Asserts nothing.", logPath: expect.stringContaining("A1") },
    ]);
    expect(log.friction).toMatchObject({ verifierRejections: 3, gateRejections: 0 });
  });

  it("should reject the subtask when the verifier errors, because the gate fails closed", async () => {
    const target = await targetRepo();
    const { run } = harness(target, writesGreetingAndTest, () => ({ kind: "error", message: "The verifier gave no answer" }));

    const report = await run();

    expect(report.log.subtasks[0]).toMatchObject({ state: "blocked", verifierRejections: 3 });
    expect(report.log.subtasks[0]?.gate?.verifier).toMatchObject([
      { id: "A1", verdict: "error", reason: "The verifier gave no answer" },
    ]);
  });

  it("should reject the subtask when the verifier itself throws", async () => {
    const target = await targetRepo();
    const { run } = harness(target, writesGreetingAndTest, () => {
      throw new Error("docker is down");
    });

    const report = await run();

    expect(report.log.subtasks[0]?.state).toBe("blocked");
    expect(report.log.subtasks[0]?.gate?.verifier).toMatchObject([{ id: "A1", verdict: "error", reason: "docker is down" }]);
  });

  it("should reject the subtask as a gate rejection, without asking the verifier, when no changed file carries the ID of a Playwright criterion", async () => {
    const target = await targetRepo();
    const { run, verifier } = harness(target, () => ({ files: { "src/greeting.txt": "hello\n" }, commit: "Write the greeting" }));

    const report = await run();

    expect(verifier.questions).toEqual([]);
    expect(report.log.subtasks[0]).toMatchObject({ state: "blocked", gateRejections: 3, verifierRejections: 0 });
    expect(report.log.subtasks[0]?.gate?.reasons).toEqual([
      "criterion A1 (playwright) has no test that carries its ID in the changes of the subtask",
    ]);
  });

  it("should not ask the verifier when the checks or the criteria already reject the subtask", async () => {
    const target = await targetRepo();
    const { run, verifier } = harness(target, () => ({
      files: { "src/greeting.txt": "bye\n", "tests/greeting.spec.ts": TEST_SOURCE },
    }));

    const report = await run();

    expect(verifier.questions).toEqual([]);
    expect(report.log.subtasks[0]?.gate?.verifier).toEqual([]);
    expect(report.log.subtasks[0]?.state).toBe("blocked");
  });

  it("should send only the test files that carry the criterion ID, not the whole change", async () => {
    const target = await targetRepo();
    const { run, verifier } = harness(target, () => ({
      files: {
        "src/greeting.txt": "hello\n",
        "tests/greeting.spec.ts": TEST_SOURCE,
        "tests/other.spec.ts": 'test("A10 something else", async () => {});\n',
      },
    }));

    await run();

    expect(verifier.questions.map((question) => question.test)).toEqual([TEST_SOURCE]);
  });
});
