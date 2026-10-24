import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approveSpec } from "../../src/commands/approve.ts";
import { runIssue, type RunRequest } from "../../src/coordinator/run.ts";
import type { RunLog } from "../../src/coordinator/run-log.ts";
import { listWorktrees, revParse } from "../../src/workers/git.ts";
import { execOk } from "../../src/workers/sh.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeGitHub } from "../fakes/github.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeWorkerRunner, type AttemptScript } from "../fakes/worker-runner.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

const ISSUE = 42;
const BRANCH = "factory/42-greeting";
const TOKEN = "token-of-the-host";

const ISSUE_BODY = [
  "## What to build",
  "",
  "A greeting.",
  "",
  "## Acceptance criteria",
  "",
  "- [ ] A1 The greeting says hello.",
  "",
].join("\n");

const SPEC = [
  "# Spec #42",
  "",
  "One subtask writes the greeting.",
  "",
  "```json factory-spec",
  JSON.stringify(
    {
      files: { A1: ["src/greeting.txt"] },
      base: null,
      subtasks: [{ id: "S1", criteria: ["A1"], scope: ["src/"], dependsOn: [], testChanges: [] }],
      criteria: { A1: { evidence: "request", level: "subtask" } },
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
  environment: ({ purpose, subtask, slot }) => ({
    DATABASE_URL: "postgres://neon/" + (subtask ?? purpose),
    E2E_PORT: String(4000 + slot),
  }),
  protectedPaths: ["package.json"],
  roles: {
    workers: { agent: "claude-code", model: "sonnet" },
    verifier: { agent: "opencode", model: "opencode-go/kimi-k2" },
  },
};
`;

async function git(dir: string, ...args: string[]): Promise<string> {
  return (await execOk("git", ["-C", dir, ...args])).trim();
}

interface Target {
  repoDir: string;
  remoteDir: string;
  github: FakeGitHub;
}

async function targetRepo(options: { config?: string | null; issueBody?: string } = {}): Promise<Target> {
  const repoDir = await temp.make("run-target-");
  const remoteDir = await temp.make("run-remote-");
  await execOk("git", ["init", "-q", "--bare", "-b", "main", remoteDir]);
  await execOk("git", ["init", "-q", "-b", "main", repoDir]);
  await git(repoDir, "config", "user.name", "t");
  await git(repoDir, "config", "user.email", "t@t");
  await git(repoDir, "remote", "add", "origin", remoteDir);
  await writeFile(join(repoDir, "README.md"), "# greeting\n");
  await writeFile(join(repoDir, ".gitignore"), ".factory/logs/\n.factory/worktrees/\n");
  const config = options.config === undefined ? CONFIG : options.config;
  if (config !== null) {
    await mkdir(join(repoDir, ".factory"));
    await writeFile(join(repoDir, ".factory", "config.ts"), config);
  }
  await git(repoDir, "add", ".");
  await git(repoDir, "commit", "-q", "-m", "init");
  await git(repoDir, "push", "-q", "origin", "main");
  await git(repoDir, "switch", "-q", "-c", BRANCH);
  await mkdir(join(repoDir, "specs"));
  await writeFile(join(repoDir, "specs", "42.md"), SPEC);
  await git(repoDir, "add", ".");
  await git(repoDir, "commit", "-q", "-m", "Spec #42");
  await git(repoDir, "switch", "-q", "main");
  const github = new FakeGitHub([{ number: ISSUE, title: "Greeting", body: options.issueBody ?? ISSUE_BODY }]);
  await approveSpec({ repoDir, issue: ISSUE, github, protectedPaths: ["package.json"], now: new Date("2026-10-24T07:00:00Z") });
  return { repoDir, remoteDir, github };
}

function harness(target: Target, script: AttemptScript) {
  const runner = new FakeWorkerRunner(script);
  const notifier = new FakeNotifier();
  const clock = new FakeClock("2026-10-24T08:00:00.000Z");
  const request: RunRequest = {
    repoDir: target.repoDir,
    issue: ISSUE,
    credentials: { "claude-code": TOKEN },
  };
  const run = () => runIssue(request, { runner, github: target.github, notifier, clock });
  return { runner, notifier, clock, run };
}

const writesHello: AttemptScript = () => ({ files: { "src/greeting.txt": "hello\n" }, commit: "Write the greeting" });
const writesBye: AttemptScript = () => ({ files: { "src/greeting.txt": "bye\n" }, commit: "Write the greeting" });

async function readRunLog(path: string): Promise<RunLog> {
  return JSON.parse(await readFile(path, "utf8")) as RunLog;
}

describe("factory run for a one-subtask spec", () => {
  it("should merge a subtask that passes its gate, push the integration branch and open a pull request ready for review", async () => {
    const target = await targetRepo();
    const { run, notifier } = harness(target, writesHello);

    const report = await run();

    expect(report.result).toBe("ready");
    expect(await git(target.repoDir, "show", `${BRANCH}:src/greeting.txt`)).toBe("hello");
    expect(await git(target.repoDir, "log", "-1", "--format=%B", BRANCH)).toContain("Factory-Subtask: S1");
    expect(await revParse(target.remoteDir, BRANCH)).toBe(await revParse(target.repoDir, BRANCH));
    expect(target.github.pullRequests).toHaveLength(1);
    expect(target.github.pullRequests[0]).toMatchObject({ head: BRANCH, base: "main", draft: false });
    expect(target.github.pullRequests[0]?.body).toContain("Closes #42");
    expect(notifier.sent).toEqual([
      expect.objectContaining({ url: target.github.pullRequests[0]?.url }),
    ]);
  });

  it("should stop before any worker starts when the criteria of the issue changed since the approval, naming that part", async () => {
    const target = await targetRepo();
    target.github.issues.set(ISSUE, { number: ISSUE, title: "Greeting", body: ISSUE_BODY.replace("says hello", "says hi") });
    const { run, runner } = harness(target, writesHello);

    await expect(run()).rejects.toThrow("the acceptance criteria of issue #42 changed since the approval");
    expect(runner.workers).toEqual([]);
    expect(target.github.pullRequests).toEqual([]);
  });

  it("should stop before any worker starts when specs/<n>.md changed since the approval, naming that part", async () => {
    const target = await targetRepo();
    await execOk("git", ["-C", target.repoDir, "switch", "-q", BRANCH]);
    const specPath = join(target.repoDir, "specs", "42.md");
    await writeFile(specPath, (await readFile(specPath, "utf8")).replace("writes the greeting", "writes a greeting"));
    await git(target.repoDir, "commit", "-q", "-am", "Edit spec");
    await git(target.repoDir, "switch", "-q", "main");
    const { run, runner } = harness(target, writesHello);

    const error = await run().then(
      () => "",
      (caught: Error) => caught.message,
    );

    expect(error).toContain("specs/42.md changed since the approval");
    expect(error).not.toContain("acceptance criteria");
    expect(runner.workers).toEqual([]);
  });

  it("should stop with a clear message before any worker starts when .factory/config.ts is missing", async () => {
    const target = await targetRepo({ config: null });
    const { run, runner } = harness(target, writesHello);

    await expect(run()).rejects.toThrow(`${join(target.repoDir, ".factory", "config.ts")} does not exist`);
    expect(runner.workers).toEqual([]);
  });

  it("should stop with a clear message before any worker starts when .factory/config.ts is invalid", async () => {
    const target = await targetRepo({ config: CONFIG.replace('image: "greeting-worker:dev",', "") });
    const { run, runner } = harness(target, writesHello);

    await expect(run()).rejects.toThrow("image must be a non-empty string");
    expect(runner.workers).toEqual([]);
  });

  it("should stop before any worker starts when the host has no credential for the agent of the workers", async () => {
    const target = await targetRepo();
    const runner = new FakeWorkerRunner(writesHello);
    const ports = { runner, github: target.github, notifier: new FakeNotifier(), clock: new FakeClock("2026-10-24T08:00:00Z") };

    await expect(runIssue({ repoDir: target.repoDir, issue: ISSUE, credentials: {} }, ports)).rejects.toThrow(
      "CLAUDE_CODE_OAUTH_TOKEN is not set",
    );
    expect(runner.workers).toEqual([]);
  });

  it("should give each worker only the environment the config gives for it, and the agent credential only to the agent's worker", async () => {
    const target = await targetRepo();
    const { run, runner } = harness(target, writesHello);

    await run();

    const [worker, gate, verification] = runner.workers;
    expect(worker?.spec.env).toEqual({
      DATABASE_URL: "postgres://neon/S1",
      E2E_PORT: "4000",
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
    });
    expect(gate?.spec.env).toEqual({ DATABASE_URL: "postgres://neon/S1", E2E_PORT: "4000" });
    expect(verification?.spec.env).toEqual({ DATABASE_URL: "postgres://neon/verification", E2E_PORT: "4000" });
    expect(worker?.spec.image).toBe("greeting-worker:dev");
  });

  it("should prompt the worker with its criteria, its scope paths and the protected paths", async () => {
    const target = await targetRepo();
    const { run, runner } = harness(target, writesHello);

    await run();

    const prompt = runner.workers[0]?.attempts[0]?.prompt ?? "";
    expect(prompt).toContain("- A1 The greeting says hello.");
    expect(prompt).toContain("- src/");
    expect(prompt).toContain("- package.json");
    expect(runner.workers[0]?.attempts[0]?.agent).toEqual({ kind: "claude-code", model: "sonnet" });
  });

  it("should run the gate and the integrated checks in fresh workers through exec, never in the worker that made the change", async () => {
    const target = await targetRepo();
    const { run, runner } = harness(target, writesHello);

    await run();

    const [worker, gate, verification] = runner.workers;
    expect(runner.workers).toHaveLength(3);
    expect(worker?.execs).toEqual([]);
    expect(gate?.attempts).toEqual([]);
    expect(gate?.execs).toEqual([{ command: "grep -q hello src/greeting.txt", exitCode: 0 }]);
    expect(verification?.attempts).toEqual([]);
    expect(verification?.execs).toEqual([{ command: "grep -q hello src/greeting.txt", exitCode: 0 }]);
    expect(runner.workers.every((record) => record.closed)).toBe(true);
    expect(await listWorktrees(target.repoDir)).toEqual([{ path: target.repoDir, branch: "main" }]);
  });

  it("should not merge a subtask whose checks fail at the gate and should open a draft that states what failed", async () => {
    const target = await targetRepo();
    const integrationBefore = await revParse(target.repoDir, BRANCH);
    const { run, notifier } = harness(target, writesBye);

    const report = await run();

    expect(report.result).toBe("draft");
    expect(await revParse(target.repoDir, BRANCH)).toBe(integrationBefore);
    const pullRequest = target.github.pullRequests[0];
    expect(pullRequest?.draft).toBe(true);
    expect(pullRequest?.body).toContain("**S1** (A1): blocked. The gate rejected it: check greeting failed with exit code 1.");
    expect(pullRequest?.body).toContain("- [ ] greeting: `grep -q hello src/greeting.txt` failed with exit code 2");
    expect(notifier.sent[0]?.url).toBe(pullRequest?.url);
  });

  it("should open a draft when the subtask merges but the integrated verification fails", async () => {
    const target = await targetRepo({
      config: CONFIG.replace(
        'checks: [{ name: "greeting", command: "grep -q hello src/greeting.txt" }]',
        'checks: [{ name: "greeting", command: "grep -q hello src/greeting.txt" }, { name: "integrated", command: "git rev-parse --abbrev-ref HEAD | grep -qv verification" }]',
      ),
    });
    const { run } = harness(target, writesHello);

    const report = await run();

    expect(report.log.subtasks[0]?.state).toBe("merged");
    expect(report.log.verification?.passed).toBe(false);
    expect(report.result).toBe("draft");
    expect(target.github.pullRequests[0]?.draft).toBe(true);
    expect(target.github.pullRequests[0]?.body).toContain("Draft: the integrated verification failed.");
  });

  it("should update the same pull request when the run starts again instead of opening a second one", async () => {
    const target = await targetRepo();
    const first = harness(target, writesBye);
    await first.run();
    const second = harness(target, writesHello);
    second.clock.advance(60_000);

    const report = await second.run();

    expect(target.github.pullRequests).toHaveLength(1);
    expect(report.pullRequest.number).toBe(target.github.pullRequests[0]?.number);
    expect(target.github.pullRequests[0]?.draft).toBe(false);
    expect(report.result).toBe("ready");
  });

  it("should record the result, the subtask state and the path of each attempt log in run.json", async () => {
    const target = await targetRepo();
    const { run } = harness(target, () => ({
      files: { "src/greeting.txt": "hello\n" },
      usage: { inputTokens: 120, outputTokens: 30 },
    }));

    const report = await run();

    expect(report.runLogPath).toBe(join(target.repoDir, ".factory", "logs", "42-2026-10-24T08-00-00-000Z", "run.json"));
    const log = await readRunLog(report.runLogPath);
    expect(log).toMatchObject({
      version: 1,
      runId: "42-2026-10-24T08-00-00-000Z",
      issue: 42,
      integrationBranch: BRANCH,
      result: "ready",
      agents: { workers: { agent: "claude-code", model: "sonnet" } },
      pullRequest: { number: report.pullRequest.number, url: report.pullRequest.url, draft: false },
      verification: { passed: true, sha: await revParse(target.repoDir, BRANCH) },
    });
    expect(log.subtasks).toHaveLength(1);
    expect(log.subtasks[0]).toMatchObject({ id: "S1", state: "merged", criteria: ["A1"] });
    const attempt = log.subtasks[0]?.attempts[0];
    expect(attempt).toMatchObject({ number: 1, outcome: "completed", usage: { inputTokens: 120, outputTokens: 30 } });
    expect(existsSync(attempt?.logPath ?? "")).toBe(true);
    expect(attempt?.logPath.startsWith(join(target.repoDir, ".factory", "logs", log.runId))).toBe(true);
  });

  it("should pause instead of blocking the subtask when the attempt reaches the plan limit, and say so in a draft", async () => {
    const target = await targetRepo();
    const { run, runner } = harness(target, () => ({
      outcome: { kind: "plan-limit", message: "5-hour limit reached" },
    }));

    const report = await run();

    expect(report.result).toBe("paused");
    expect(report.log.subtasks[0]?.state).toBe("pending");
    expect(runner.workers).toHaveLength(1);
    expect(target.github.pullRequests[0]?.draft).toBe(true);
    expect(target.github.pullRequests[0]?.body).toContain("Paused: the plan limit of claude-code was reached: 5-hour limit reached");
  });

  it("should block the subtask with the outcome when its attempt does not complete", async () => {
    const target = await targetRepo();
    const { run } = harness(target, () => ({ outcome: { kind: "agent-error", message: "exit 1", exitCode: 1 } }));

    const report = await run();

    expect(report.log.subtasks[0]).toMatchObject({ state: "blocked", reason: "Its attempt ended with agent-error: exit 1." });
    expect(report.result).toBe("draft");
  });
});
