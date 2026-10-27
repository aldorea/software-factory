import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approveSpec } from "../../src/commands/approve.ts";
import { runIssue, type RunRequest } from "../../src/coordinator/run.ts";
import type { RunLog } from "../../src/coordinator/run-log.ts";
import { listWorktrees, revParse } from "../../src/workers/git.ts";
import { execOk } from "../../src/workers/sh.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeGitHub } from "../fakes/github.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeVerifier } from "../fakes/verifier.ts";
import { FakeWorkerRunner, type AttemptCall, type AttemptScript, type ScriptedAttempt } from "../fakes/worker-runner.ts";
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

function specText(testChanges: string[] = []): string {
  return [
    "# Spec #42",
    "",
    "One subtask writes the greeting.",
    "",
    "```json factory-spec",
    JSON.stringify(
      {
        files: { A1: ["src/greeting.txt"] },
        base: null,
        subtasks: [{ id: "S1", criteria: ["A1"], scope: ["src/"], dependsOn: [], testChanges }],
        criteria: { A1: { evidence: "request", level: "subtask" } },
      },
      null,
      2,
    ),
    "```",
    "",
  ].join("\n");
}

function configWith(extra: string): string {
  return CONFIG.replace("  roles:", `  ${extra},\n  roles:`);
}

const CONFIG = `
export default {
  image: "greeting-worker:dev",
  checks: [{ name: "greeting", command: "grep -q hello src/greeting.txt" }],
  evidence: { request: "grep -q hello src/greeting.txt # {{id}}" },
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

interface TargetOptions {
  config?: string | null;
  issueBody?: string;
  testChanges?: string[];
  files?: Record<string, string>;
}

async function targetRepo(options: TargetOptions = {}): Promise<Target> {
  const repoDir = await temp.make("run-target-");
  const remoteDir = await temp.make("run-remote-");
  await execOk("git", ["init", "-q", "--bare", "-b", "main", remoteDir]);
  await execOk("git", ["init", "-q", "-b", "main", repoDir]);
  await git(repoDir, "config", "user.name", "t");
  await git(repoDir, "config", "user.email", "t@t");
  await git(repoDir, "remote", "add", "origin", remoteDir);
  await git(repoDir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  await writeFile(join(repoDir, "README.md"), "# greeting\n");
  await writeFile(join(repoDir, ".gitignore"), ".factory/logs/\n.factory/worktrees/\n");
  for (const [path, content] of Object.entries(options.files ?? {})) {
    await mkdir(dirname(join(repoDir, path)), { recursive: true });
    await writeFile(join(repoDir, path), content);
  }
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
  await writeFile(join(repoDir, "specs", "42.md"), specText(options.testChanges));
  await git(repoDir, "add", ".");
  await git(repoDir, "commit", "-q", "-m", "Spec #42");
  await git(repoDir, "switch", "-q", "main");
  const github = new FakeGitHub([{ number: ISSUE, title: "Greeting", body: options.issueBody ?? ISSUE_BODY }]);
  await approveSpec({ repoDir, issue: ISSUE, github, protectedPaths: ["package.json"], now: new Date("2026-10-24T07:00:00Z") });
  return { repoDir, remoteDir, github };
}

function harness(target: Target, script: (call: AttemptCall, clock: FakeClock) => ScriptedAttempt | Promise<ScriptedAttempt>) {
  const notifier = new FakeNotifier();
  const clock = new FakeClock("2026-10-24T08:00:00.000Z");
  const runner = new FakeWorkerRunner((call) => script(call, clock));
  const request: RunRequest = {
    repoDir: target.repoDir,
    issue: ISSUE,
    credentials: { "claude-code": TOKEN },
  };
  const run = () => runIssue(request, { runner, verifier: new FakeVerifier(), github: target.github, notifier, clock });
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
    const ports = { runner, verifier: new FakeVerifier(), github: target.github, notifier: new FakeNotifier(), clock: new FakeClock("2026-10-24T08:00:00Z") };

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
    expect(gate?.execs).toEqual([
      { command: "grep -q hello src/greeting.txt", exitCode: 0 },
      { command: "grep -q hello src/greeting.txt # A1", exitCode: 0 },
    ]);
    expect(verification?.attempts).toEqual([]);
    expect(verification?.execs).toEqual([
      { command: "grep -q hello src/greeting.txt", exitCode: 0 },
      { command: "grep -q hello src/greeting.txt # A1", exitCode: 0 },
    ]);
    expect(runner.workers.every((record) => record.closed)).toBe(true);
    expect(await listWorktrees(target.repoDir)).toEqual([{ path: target.repoDir, branch: "main" }]);
  });

  it("should not merge a subtask whose checks keep failing at the gate and should open a draft that states what failed", async () => {
    const target = await targetRepo();
    const integrationBefore = await revParse(target.repoDir, BRANCH);
    const { run, notifier } = harness(target, writesBye);

    const report = await run();

    expect(report.result).toBe("draft");
    expect(await revParse(target.repoDir, BRANCH)).toBe(integrationBefore);
    const pullRequest = target.github.pullRequests[0];
    expect(pullRequest?.draft).toBe(true);
    expect(pullRequest?.body).toContain("**S1** (A1): blocked.");
    expect(pullRequest?.body).toContain(
      "Last failure: The gate rejected the work: check greeting failed with exit code 1; criterion A1 (request) failed with exit code 1",
    );
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
    expect(target.github.pullRequests[0]?.body).toContain(
      "Draft: the integrated verification failed; the run is blocked by integration-check (see Blocks).",
    );
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

  it("should block the subtask by patience when its attempts keep ending in the same agent error", async () => {
    const target = await targetRepo();
    const { run, runner } = harness(target, () => ({ outcome: { kind: "agent-error", message: "exit 1", exitCode: 1 } }));

    const report = await run();

    expect(runner.workers[0]?.attempts).toHaveLength(3);
    expect(report.log.subtasks[0]).toMatchObject({
      state: "blocked",
      block: { type: "patience", lastFailure: "The agent failed with exit code 1: exit 1" },
    });
    expect(report.log.subtasks[0]?.reason).toContain("3 attempts in a row failed with the same error signature: agent-error: exit 1");
    expect(report.result).toBe("draft");
  });
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("factory run: gate rejections", () => {
  it("should reject a diff that touches a path outside the scope paths and name the path in the pull request", async () => {
    const target = await targetRepo();
    const { run } = harness(target, () => ({ files: { "src/greeting.txt": "hello\n", "docs/notes.md": "notes\n" } }));

    const report = await run();

    expect(report.log.subtasks[0]?.gate).toMatchObject({
      accepted: false,
      reasons: ["it touches paths outside its scope (src/): docs/notes.md"],
    });
    expect(report.log.subtasks[0]?.state).toBe("blocked");
    expect(target.github.pullRequests[0]?.body).toContain("docs/notes.md");
  });

  it("should reject a diff that touches a protected path, even though the checks pass", async () => {
    const target = await targetRepo();
    const { run } = harness(target, () => ({ files: { "src/greeting.txt": "hello\n", "package.json": "{}\n" } }));

    const report = await run();

    expect(report.log.subtasks[0]?.gate?.checks.every((check) => check.passed)).toBe(true);
    expect(report.log.subtasks[0]?.gate?.reasons).toEqual(["it touches protected paths: package.json"]);
  });

  it("should reject a diff that touches the .factory folder, because a worker cannot change the limits of its own run", async () => {
    const target = await targetRepo();
    const { run } = harness(target, () => ({ files: { "src/greeting.txt": "hello\n", ".factory/config.ts": "export default {};\n" } }));

    const report = await run();

    expect(report.log.subtasks[0]?.gate?.reasons).toEqual(["it touches protected paths: .factory/config.ts"]);
  });

  it("should reject a change to a test file that existed before the run when the spec does not authorize it", async () => {
    const target = await targetRepo({ files: { "src/greeting.test.ts": "export const old = 1;\n" } });
    const { run } = harness(target, () => ({ files: { "src/greeting.txt": "hello\n", "src/greeting.test.ts": "export const old = 2;\n" } }));

    const report = await run();

    expect(report.log.subtasks[0]?.gate?.reasons).toEqual([
      "it changes existing tests that the spec does not authorize: src/greeting.test.ts",
    ]);
    expect(report.result).toBe("draft");
  });

  it("should accept a change to an existing test that the spec authorizes", async () => {
    const target = await targetRepo({
      files: { "src/greeting.test.ts": "export const old = 1;\n" },
      testChanges: ["src/greeting.test.ts"],
    });
    const { run } = harness(target, () => ({ files: { "src/greeting.txt": "hello\n", "src/greeting.test.ts": "export const old = 2;\n" } }));

    const report = await run();

    expect(report.result).toBe("ready");
    expect(await git(target.repoDir, "show", `${BRANCH}:src/greeting.test.ts`)).toContain("old = 2");
  });

  it("should accept a new test file in the scope, because only the tests that existed before the run are fixed", async () => {
    const target = await targetRepo({ files: { "src/greeting.test.ts": "export const old = 1;\n" } });
    const { run } = harness(target, () => ({ files: { "src/greeting.txt": "hello\n", "src/new.test.ts": "export const fresh = 1;\n" } }));

    expect((await run()).result).toBe("ready");
  });

  it("should give the next attempt the last failure in its prompt, and merge when that attempt passes", async () => {
    const target = await targetRepo();
    const { run, runner } = harness(target, (call) => ({
      files: { "src/greeting.txt": call.number === 1 ? "bye\n" : "hello\n" },
    }));

    const report = await run();

    const [first, second] = runner.workers[0]?.attempts ?? [];
    expect(first?.prompt).not.toContain("Last failure");
    expect(second?.prompt).toContain("Last failure");
    expect(second?.prompt).toContain("check greeting failed with exit code 1");
    expect(report.result).toBe("ready");
    expect(report.log.subtasks[0]?.attempts.map((attempt) => attempt.failure?.signature)).toEqual(["check:greeting | criterion:A1", undefined]);
    expect(report.log.subtasks[0]?.state).toBe("merged");
  });

  it("should keep the worker and its branch between attempts, so the next attempt starts from the last commit", async () => {
    const target = await targetRepo();
    const { run, runner } = harness(target, (call) => ({
      files: call.number === 1 ? { "src/greeting.txt": "bye\n" } : { "src/greeting.txt": "hello\n" },
      commit: `Attempt ${call.number}`,
    }));

    await run();

    expect(runner.workers.filter((worker) => worker.spec.id === "42-S1")).toHaveLength(1);
    const subjects = (await git(target.repoDir, "log", "--format=%s", BRANCH)).split("\n");
    expect(subjects).toEqual(expect.arrayContaining(["Attempt 1", "Attempt 2"]));
  });
});

describe("factory run: stop rules", () => {
  it("should block by patience after 3 attempts in a row with the same signature, with the reason and the last failure in the pull request and the type in run.json", async () => {
    const target = await targetRepo();
    const { run, runner } = harness(target, writesBye);

    const report = await run();

    expect(runner.workers[0]?.attempts).toHaveLength(3);
    const subtask = report.log.subtasks[0];
    expect(subtask?.state).toBe("blocked");
    expect(subtask?.block).toMatchObject({ type: "patience" });
    const body = target.github.pullRequests[0]?.body ?? "";
    expect(body).toContain("3 attempts in a row failed with the same error signature: check:greeting");
    expect(body).toContain("Last failure: The gate rejected the work: check greeting failed with exit code 1");
    const logged = await readRunLog(report.runLogPath);
    expect(logged.subtasks[0]?.block?.type).toBe("patience");
    expect(logged.subtasks[0]?.block?.lastFailure).toContain("check greeting failed");
  });

  it("should reset the count of patience when a different signature comes in between, and go on to merge", async () => {
    const target = await targetRepo();
    const { run, runner } = harness(target, (call) => {
      if (call.number === 3) return { outcome: { kind: "agent-error", message: "boom", exitCode: 1 } };
      if (call.number === 6) return { files: { "src/greeting.txt": "hello\n" } };
      return { files: { "src/greeting.txt": "bye\n" } };
    });

    const report = await run();

    expect(runner.workers[0]?.attempts).toHaveLength(6);
    expect(report.log.subtasks[0]?.state).toBe("merged");
    expect(report.result).toBe("ready");
  });

  it("should count a deadline as a failure with its own signature", async () => {
    const target = await targetRepo();
    const { run } = harness(target, () => ({ outcome: { kind: "deadline" } }));

    const report = await run();

    expect(report.log.subtasks[0]?.attempts.map((attempt) => attempt.failure?.signature)).toEqual(["deadline", "deadline", "deadline"]);
    expect(report.log.subtasks[0]?.block?.type).toBe("patience");
  });

  it("should count an idle timeout as a failure with its own signature", async () => {
    const target = await targetRepo();
    const { run } = harness(target, (call) => (call.number === 1 ? { outcome: { kind: "idle-timeout" } } : { outcome: { kind: "deadline" } }));

    const report = await run();

    expect(report.log.subtasks[0]?.attempts.map((attempt) => attempt.failure?.signature).slice(0, 2)).toEqual(["idle-timeout", "deadline"]);
  });

  it("should not spend patience on a plan limit, and should leave the subtask pending", async () => {
    const target = await targetRepo();
    const { run, runner } = harness(target, (call) =>
      call.number < 3 ? { files: { "src/greeting.txt": "bye\n" } } : { outcome: { kind: "plan-limit", message: "limit" } },
    );

    const report = await run();

    expect(runner.workers[0]?.attempts).toHaveLength(3);
    expect(report.result).toBe("paused");
    expect(report.log.subtasks[0]?.state).toBe("pending");
  });

  it("should block a subtask that reached its wall clock of 2 h, with its own type, whatever the signatures", async () => {
    const target = await targetRepo();
    const { run, runner } = harness(target, (call, clock) => {
      clock.advance(call.number === 1 ? 2 * HOUR : 0);
      return { files: { "src/greeting.txt": "bye\n" } };
    });

    const report = await run();

    expect(runner.workers[0]?.attempts).toHaveLength(1);
    expect(report.log.subtasks[0]?.block).toMatchObject({ type: "subtask-wall-clock" });
    expect(report.log.subtasks[0]?.reason).toContain("2 h");
  });

  it("should take the wall clock of a subtask from .factory/config.ts, and give each attempt that deadline", async () => {
    const target = await targetRepo({ config: configWith("limits: { subtaskWallClockMs: 1800000 }") });
    const { run, runner } = harness(target, (_call, clock) => {
      clock.advance(31 * MINUTE);
      return { files: { "src/greeting.txt": "bye\n" } };
    });

    const report = await run();

    expect(report.log.subtasks[0]?.block?.type).toBe("subtask-wall-clock");
    expect(runner.workers[0]?.attempts[0]?.limits.deadline.toISOString()).toBe("2026-10-24T08:30:00.000Z");
  });

  it("should block a subtask that reached its token limit, counting input without cache, cache creation and output", async () => {
    const target = await targetRepo({ config: configWith('agents: { "claude-code": { tokensPerSubtask: 500 } }') });
    const { run, runner } = harness(target, () => ({
      files: { "src/greeting.txt": "bye\n" },
      usage: { inputTokens: 100, cacheCreationInputTokens: 150, outputTokens: 250, cacheReadInputTokens: 900_000 },
    }));

    const report = await run();

    expect(runner.workers[0]?.attempts).toHaveLength(1);
    expect(report.log.subtasks[0]?.block).toMatchObject({ type: "subtask-tokens" });
    expect(report.log.subtasks[0]?.reason).toContain("500 tokens");
  });

  it("should block the run when it reached its wall clock, with its own type", async () => {
    const target = await targetRepo({ config: configWith("limits: { runWallClockMs: 3600000 }") });
    const { run } = harness(target, (_call, clock) => {
      clock.advance(61 * MINUTE);
      return { files: { "src/greeting.txt": "bye\n" } };
    });

    const report = await run();

    expect(report.log.subtasks[0]?.block?.type).toBe("run-wall-clock");
    expect(report.result).toBe("draft");
  });

  it("should block the run when it reached its token limit, with its own type", async () => {
    const target = await targetRepo({ config: configWith('agents: { "claude-code": { tokensPerRun: 1000 } }') });
    const { run } = harness(target, () => ({ files: { "src/greeting.txt": "bye\n" }, usage: { outputTokens: 1500 } }));

    const report = await run();

    expect(report.log.subtasks[0]?.block?.type).toBe("run-tokens");
  });

  it("should use the defaults of the design when the config sets no limits", async () => {
    const target = await targetRepo();
    const { run, runner } = harness(target, writesBye);

    await run();

    expect(runner.workers[0]?.attempts[0]?.limits.deadline.toISOString()).toBe("2026-10-24T10:00:00.000Z");
  });
});
