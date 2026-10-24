import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approveSpec } from "../../src/commands/approve.ts";
import { runIssue } from "../../src/coordinator/run.ts";
import { execOk } from "../../src/workers/sh.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeGitHub } from "../fakes/github.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeVerifier } from "../fakes/verifier.ts";
import { FakeWorkerRunner, type AttemptScript } from "../fakes/worker-runner.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

const ISSUE = 42;
const BRANCH = "factory/42-greeting";

const ISSUE_BODY = [
  "## What to build",
  "",
  "A greeting.",
  "",
  "## Acceptance criteria",
  "",
  "- [ ] A1 The greeting page says hello.",
  "- [ ] A2 The greeting endpoint answers hello.",
  "- [ ] A3 The greeting looks friendly.",
  "",
].join("\n");

const SPEC = [
  "# Spec #42",
  "",
  "```json factory-spec",
  JSON.stringify(
    {
      files: { A1: ["src/greeting.txt"], A2: ["src/greeting.txt"], A3: ["src/greeting.txt"] },
      base: null,
      subtasks: [{ id: "S1", criteria: ["A1", "A2", "A3"], scope: ["src/", "e2e/", "requests/"], dependsOn: [], testChanges: [] }],
      criteria: {
        A1: { evidence: "playwright", level: "subtask" },
        A2: { evidence: "request", level: "integration" },
        A3: { evidence: "human", level: "integration", reason: "Friendliness is subjective." },
      },
    },
    null,
    2,
  ),
  "```",
  "",
].join("\n");

const PLAYWRIGHT =
  'mkdir -p test-results; cp e2e/{{id}}.png test-results/ 2>/dev/null; test "$(cat e2e/{{id}}.result)" = pass';
const REQUEST = 'test "$(cat requests/{{id}}.result)" = pass';

interface ConfigOptions {
  playwright?: string | null;
  request?: string | null;
  app?: string;
  ready?: string;
}

function configSource(options: ConfigOptions = {}): string {
  const playwright = options.playwright === undefined ? PLAYWRIGHT : options.playwright;
  const request = options.request === undefined ? REQUEST : options.request;
  return `
export default {
  image: "greeting-worker:dev",
  checks: [{ name: "greeting", command: "grep -q hello src/greeting.txt" }],
  evidence: {
    ${playwright === null ? "" : `playwright: ${JSON.stringify(playwright)},`}
    ${request === null ? "" : `request: ${JSON.stringify(request)},`}
    attachments: "test-results",
  },
  ${options.app === undefined ? "" : `app: { start: ${JSON.stringify(options.app)}${options.ready === undefined ? "" : `, ready: ${JSON.stringify(options.ready)}, readyTimeoutMs: 1500`} },`}
  environment: () => ({}),
  protectedPaths: ["package.json"],
  roles: {
    workers: { agent: "claude-code", model: "sonnet" },
    verifier: { agent: "opencode", model: "opencode-go/kimi-k2" },
  },
};
`;
}

async function git(dir: string, ...args: string[]): Promise<string> {
  return (await execOk("git", ["-C", dir, ...args])).trim();
}

interface Target {
  repoDir: string;
  github: FakeGitHub;
}

async function targetRepo(config: string): Promise<Target> {
  const repoDir = await temp.make("evidence-target-");
  const remoteDir = await temp.make("evidence-remote-");
  await execOk("git", ["init", "-q", "--bare", "-b", "main", remoteDir]);
  await execOk("git", ["init", "-q", "-b", "main", repoDir]);
  await git(repoDir, "config", "user.name", "t");
  await git(repoDir, "config", "user.email", "t@t");
  await git(repoDir, "remote", "add", "origin", remoteDir);
  await writeFile(join(repoDir, "README.md"), "# greeting\n");
  await writeFile(join(repoDir, ".gitignore"), ".factory/logs/\n.factory/worktrees/\n");
  await mkdir(join(repoDir, ".factory"));
  await writeFile(join(repoDir, ".factory", "config.ts"), config);
  await git(repoDir, "add", ".");
  await git(repoDir, "commit", "-q", "-m", "init");
  await git(repoDir, "push", "-q", "origin", "main");
  await git(repoDir, "switch", "-q", "-c", BRANCH);
  await mkdir(join(repoDir, "specs"));
  await writeFile(join(repoDir, "specs", "42.md"), SPEC);
  await git(repoDir, "add", ".");
  await git(repoDir, "commit", "-q", "-m", "Spec #42");
  await git(repoDir, "switch", "-q", "main");
  const github = new FakeGitHub([{ number: ISSUE, title: "Greeting", body: ISSUE_BODY }]);
  await approveSpec({ repoDir, issue: ISSUE, github, protectedPaths: ["package.json"], now: new Date("2026-10-24T07:00:00Z") });
  return { repoDir, github };
}

function harness(target: Target, script: AttemptScript) {
  const runner = new FakeWorkerRunner(script);
  const clock = new FakeClock("2026-10-24T08:00:00.000Z");
  const run = () =>
    runIssue(
      { repoDir: target.repoDir, issue: ISSUE, credentials: { "claude-code": "token", opencode: "key" } },
      { runner, verifier: new FakeVerifier(), github: target.github, notifier: new FakeNotifier(), clock },
    );
  return { runner, run };
}

function writes(results: { A1?: string; A2?: string; greeting?: string } = {}): AttemptScript {
  return () => ({
    files: {
      "src/greeting.txt": `${results.greeting ?? "hello"}\n`,
      "e2e/A1.result": `${results.A1 ?? "pass"}\n`,
      "e2e/greeting.spec.ts": 'test("A1 the greeting page says hello", async () => {});\n',
      "e2e/A3.png": "png-of-the-greeting\n",
      "requests/A2.result": `${results.A2 ?? "pass"}\n`,
    },
    commit: "Write the greeting",
  });
}

describe("criterion evidence at the gate", () => {
  it("should run only the subtask-level criteria of the subtask at the gate, with the criterion ID in the command", async () => {
    const target = await targetRepo(configSource());
    const { run, runner } = harness(target, writes());

    const report = await run();

    const gate = runner.workers[1];
    expect(gate?.execs.map((exec) => exec.command)).toEqual([
      "grep -q hello src/greeting.txt",
      PLAYWRIGHT.replaceAll("{{id}}", "A1"),
    ]);
    expect(report.log.subtasks[0]?.gate?.criteria).toEqual([
      { id: "A1", evidence: "playwright", command: PLAYWRIGHT.replaceAll("{{id}}", "A1"), exitCode: 0, passed: true },
    ]);
  });

  it("should reject a subtask whose criterion test fails at the gate, with the criterion ID in the reason, even when its checks pass", async () => {
    const target = await targetRepo(configSource());
    const { run } = harness(target, writes({ A1: "fail" }));

    const report = await run();

    expect(report.log.subtasks[0]).toMatchObject({
      state: "blocked",
      block: {
        type: "patience",
        lastFailure: "The gate rejected the work: criterion A1 (playwright) failed with exit code 1",
      },
    });
    expect(report.log.subtasks[0]?.reason).toContain("criterion:A1");
    expect(report.result).toBe("draft");
  });
});

describe("criterion evidence at the integrated verification", () => {
  it("should run the evidence of every non-human criterion on the integrated app and record the result of each", async () => {
    const target = await targetRepo(configSource());
    const { run, runner } = harness(target, writes());

    const report = await run();

    expect(report.result).toBe("ready");
    expect(report.log.verification?.criteria).toEqual([
      { id: "A1", evidence: "playwright", command: PLAYWRIGHT.replaceAll("{{id}}", "A1"), exitCode: 0, passed: true },
      { id: "A2", evidence: "request", command: REQUEST.replaceAll("{{id}}", "A2"), exitCode: 0, passed: true },
    ]);
    const verification = runner.workers[2];
    expect(verification?.spec.branch).toContain("verification");
    expect(verification?.execs.map((exec) => exec.command)).toContain(REQUEST.replaceAll("{{id}}", "A2"));
  });

  it("should record a failing integration-level criterion and keep the pull request a draft naming it", async () => {
    const target = await targetRepo(configSource());
    const { run } = harness(target, writes({ A2: "fail" }));

    const report = await run();

    expect(report.log.subtasks[0]).toMatchObject({ state: "blocked", blockType: "patience" });
    expect(report.log.verification?.passed).toBe(false);
    expect(report.log.verification?.criteria.map((criterion) => [criterion.id, criterion.passed])).toEqual([
      ["A1", true],
      ["A2", false],
    ]);
    expect(report.result).toBe("draft");
    expect(target.github.pullRequests[0]?.draft).toBe(true);
    expect(target.github.pullRequests[0]?.body).toContain("the integrated verification failed (criteria not passing: A2).");
  });

  it("should start the app of the config before it runs the evidence", async () => {
    const markerDir = await temp.make("evidence-app-");
    const marker = join(markerDir, "app-started");
    const waitsForApp = `for i in $(seq 1 40); do test -f ${marker} && exit 0; sleep 0.1; done; exit 1`;
    const target = await targetRepo(configSource({ app: `touch ${marker}`, request: `${waitsForApp} # {{id}}` }));
    const { run } = harness(target, writes());

    const report = await run();

    expect(report.result).toBe("ready");
    expect(report.log.verification?.criteria.find((criterion) => criterion.id === "A2")?.passed).toBe(true);
  });
});

describe("the app of the config before the evidence", () => {
  it("should poll the readiness command of the app before it runs the evidence, because a started app may not serve yet", async () => {
    const marker = '"$PWD.app-ready"';
    const target = await targetRepo(
      configSource({ app: `sleep 0.4; touch ${marker}`, ready: `test -f ${marker}`, request: `test -f ${marker} # {{id}}` }),
    );
    const { run } = harness(target, writes());

    const report = await run();

    expect(report.log.verification?.criteria.find((criterion) => criterion.id === "A2")?.passed).toBe(true);
    expect(report.result).toBe("ready");
  });

  it("should block the subtask by the environment, as data and not as a thrown error, when the app does not become ready at the gate", async () => {
    const target = await targetRepo(configSource({ app: "true", ready: "false" }));
    const { run, runner } = harness(target, writes());

    const report = await run();

    expect(report.log.subtasks[0]).toMatchObject({ state: "blocked", blockType: "environment", block: { type: "environment" } });
    expect(report.log.subtasks[0]?.reason).toContain("the app did not become ready: false kept failing");
    expect(runner.workers.filter((worker) => worker.spec.id.endsWith("-S1"))[0]?.attempts).toHaveLength(1);
    expect(report.log.friction.blocks.environment).toBe(1);
    expect(report.result).toBe("draft");
  });

  it("should block the subtask by the environment when the start command of the app cannot even be launched", async () => {
    const target = await targetRepo(configSource({ app: "fi" }));
    const { run } = harness(target, writes());

    const report = await run();

    expect(report.log.subtasks[0]).toMatchObject({ state: "blocked", blockType: "environment" });
    expect(report.log.subtasks[0]?.reason).toContain("the app did not start: fi exited with 2");
  });

  it("should record a failed integrated verification with the reason when the app does not become ready on the integration branch", async () => {
    const target = await targetRepo(
      configSource({ app: "true", ready: "git rev-parse --abbrev-ref HEAD | grep -qv verification" }),
    );
    const { run } = harness(target, writes());

    const report = await run();

    expect(report.log.subtasks[0]?.state).toBe("merged");
    expect(report.log.verification).toMatchObject({ passed: false, criteria: [] });
    expect(report.log.verification?.environment).toContain("the app did not become ready");
    expect(report.result).toBe("draft");
    expect(target.github.pullRequests[0]?.body).toContain("the app did not become ready");
  });
});

describe("criterion evidence in the pull request", () => {
  it("should list each non-human criterion with its evidence and its result on the final SHA", async () => {
    const target = await targetRepo(configSource());
    const { run } = harness(target, writes({ A2: "fail" }));

    const report = await run();

    const body = target.github.pullRequests[0]?.body ?? "";
    const sha = report.log.verification?.sha.slice(0, 12);
    expect(body).toContain(`## Criteria on \`${sha}\``);
    expect(body).toContain(
      `- [x] A1 The greeting page says hello. Evidence: playwright \`${PLAYWRIGHT.replaceAll("{{id}}", "A1")}\``,
    );
    expect(body).toContain(
      `- [ ] A2 The greeting endpoint answers hello. Evidence: request \`${REQUEST.replaceAll("{{id}}", "A2")}\` failed with exit code 1`,
    );
  });

  it("should list the human criteria apart and unchecked, with the reason and the attachments of the Playwright run", async () => {
    const target = await targetRepo(configSource());
    const { run } = harness(target, writes());

    const report = await run();

    const body = target.github.pullRequests[0]?.body ?? "";
    expect(body).toContain("## Human criteria for your review");
    expect(body).toContain(
      `- [ ] A3 The greeting looks friendly. Reason: Friendliness is subjective. Attachments: [A3.png](https://github.test/aldorea/greeting/blob/${report.log.evidence?.commit}/${report.log.runId}/A3/A3.png)`,
    );
    expect(body).not.toContain("- [x] A3");
    expect(report.log.verification?.humanCriteria).toEqual([
      { id: "A3", reason: "Friendliness is subjective.", attachments: ["attachments/A3/A3.png"] },
    ]);
    const attachment = join(target.repoDir, ".factory", "logs", report.log.runId, "attachments", "A3", "A3.png");
    expect(await readFile(attachment, "utf8")).toBe("png-of-the-greeting\n");
  });

  it("should open the pull request ready for review when every non-human criterion passes, whatever the human ones", async () => {
    const target = await targetRepo(configSource());
    const { run } = harness(target, writes());

    const report = await run();

    expect(report.result).toBe("ready");
    expect(target.github.pullRequests[0]?.draft).toBe(false);
  });
});

describe("criterion evidence needs its commands in the config", () => {
  it("should stop before any worker starts when a criterion has a type of evidence the config gives no command for", async () => {
    const target = await targetRepo(configSource({ request: null }));
    const { run, runner } = harness(target, writes());

    await expect(run()).rejects.toThrow("criterion A2 has request evidence but .factory/config.ts gives no evidence.request command");
    expect(runner.workers).toEqual([]);
  });

  it("should stop with a clear message when an evidence command lacks the placeholder of the criterion ID", async () => {
    const target = await targetRepo(configSource({ playwright: "pnpm playwright test" }));
    const { run, runner } = harness(target, writes());

    await expect(run()).rejects.toThrow("evidence.playwright must be a command with the {{id}} placeholder");
    expect(runner.workers).toEqual([]);
  });
});
