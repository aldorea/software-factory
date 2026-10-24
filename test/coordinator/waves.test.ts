import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approveSpec } from "../../src/commands/approve.ts";
import { runIssue } from "../../src/coordinator/run.ts";
import { withBranchWorktree } from "../../src/git/repo.ts";
import type { RunLog } from "../../src/coordinator/run-log.ts";
import { execOk } from "../../src/workers/sh.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeGitHub } from "../fakes/github.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeVerifier } from "../fakes/verifier.ts";
import { FakeWorkerRunner, type AttemptCall, type ScriptedAttempt } from "../fakes/worker-runner.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

const ISSUE = 42;
const BRANCH = "factory/42-greeting";
const TOKEN = "token-of-the-host";
const NO_BAD_FILE = "! grep -rqI 'BA[D]' --exclude-dir=.git .";

interface SubtaskDefinition {
  id: string;
  scope: string[];
  dependsOn?: string[];
  testChanges?: string[];
}

interface TargetOptions {
  base?: SubtaskDefinition;
  subtasks: SubtaskDefinition[];
  maxParallel?: number;
  checkCommand?: string;
}

interface Target {
  repoDir: string;
  remoteDir: string;
  github: FakeGitHub;
}

function configText(options: TargetOptions): string {
  return `
export default {
  image: "greeting-worker:dev",
  checks: [{ name: "clean", command: ${JSON.stringify(options.checkCommand ?? "true")} }],
  environment: ({ purpose, subtask, slot }) => ({
    DATABASE_URL: "postgres://neon/" + (subtask ?? purpose),
    E2E_PORT: String(4000 + slot),
  }),
  protectedPaths: ["package.json"],
  roles: {
    workers: { agent: "claude-code", model: "sonnet" },
    verifier: { agent: "opencode", model: "opencode-go/kimi-k2" },
  },
  agents: { "claude-code": { maxParallel: ${options.maxParallel ?? 1} } },
  evidence: { request: "true # {{id}}" },
};
`;
}

function specAndIssue(options: TargetOptions): { spec: string; issueBody: string } {
  const definitions = [...(options.base ? [options.base] : []), ...options.subtasks];
  const criterionOf = (id: string) => `A${definitions.findIndex((definition) => definition.id === id) + 1}`;
  const toSubtask = (definition: SubtaskDefinition) => ({
    id: definition.id,
    criteria: [criterionOf(definition.id)],
    scope: definition.scope,
    dependsOn: definition.dependsOn ?? [],
    testChanges: definition.testChanges ?? [],
  });
  const criteria = Object.fromEntries(
    definitions.map((definition) => [criterionOf(definition.id), { evidence: "request", level: "subtask" }]),
  );
  const files = Object.fromEntries(definitions.map((definition) => [criterionOf(definition.id), definition.scope]));
  const spec = [
    "# Spec #42",
    "",
    "```json factory-spec",
    JSON.stringify(
      { files, base: options.base ? toSubtask(options.base) : null, subtasks: options.subtasks.map(toSubtask), criteria },
      null,
      2,
    ),
    "```",
    "",
  ].join("\n");
  const issueBody = [
    "## What to build",
    "",
    "A greeting.",
    "",
    "## Acceptance criteria",
    "",
    ...definitions.map((definition) => `- [ ] ${criterionOf(definition.id)} The part ${definition.id} works.`),
    "",
  ].join("\n");
  return { spec, issueBody };
}

async function git(dir: string, ...args: string[]): Promise<string> {
  return (await execOk("git", ["-C", dir, ...args])).trim();
}

async function targetRepo(options: TargetOptions): Promise<Target> {
  const repoDir = await temp.make("waves-target-");
  const remoteDir = await temp.make("waves-remote-");
  const { spec, issueBody } = specAndIssue(options);
  await execOk("git", ["init", "-q", "--bare", "-b", "main", remoteDir]);
  await execOk("git", ["init", "-q", "-b", "main", repoDir]);
  await git(repoDir, "config", "user.name", "t");
  await git(repoDir, "config", "user.email", "t@t");
  await git(repoDir, "remote", "add", "origin", remoteDir);
  await writeFile(join(repoDir, "README.md"), "# greeting\n");
  await writeFile(join(repoDir, ".gitignore"), ".factory/logs/\n.factory/worktrees/\n");
  await mkdir(join(repoDir, ".factory"));
  await writeFile(join(repoDir, ".factory", "config.ts"), configText(options));
  await git(repoDir, "add", ".");
  await git(repoDir, "commit", "-q", "-m", "init");
  await git(repoDir, "push", "-q", "origin", "main");
  await git(repoDir, "switch", "-q", "-c", BRANCH);
  await mkdir(join(repoDir, "specs"));
  await writeFile(join(repoDir, "specs", "42.md"), spec);
  await git(repoDir, "add", ".");
  await git(repoDir, "commit", "-q", "-m", "Spec #42");
  await git(repoDir, "switch", "-q", "main");
  const github = new FakeGitHub([{ number: ISSUE, title: "Greeting", body: issueBody }]);
  await approveSpec({ repoDir, issue: ISSUE, github, protectedPaths: ["package.json"], now: new Date("2026-10-24T07:00:00Z") });
  return { repoDir, remoteDir, github };
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Start {
  integrationTip: string;
  integrationMessages: string;
  branchTip: string;
  runningBefore: string[];
}

interface Observer {
  starts: Map<string, Start>;
  order: string[];
  peak: number;
}

function observed(
  target: Target,
  behaviour: (id: string) => ScriptedAttempt,
  attemptMs = 0,
  before: (id: string) => Promise<void> = async () => undefined,
  rendezvous = 0,
): { observer: Observer; runner: FakeWorkerRunner; run: () => ReturnType<typeof runIssue>; clock: FakeClock } {
  const observer: Observer = { starts: new Map(), order: [], peak: 0 };
  const running = new Set<string>();
  let arrivals = 0;
  const runner = new FakeWorkerRunner(async (call: AttemptCall) => {
    const id = call.spec.id.replace(`${ISSUE}-`, "");
    const position = observer.order.push(id);
    observer.starts.set(id, {
      integrationTip: await git(target.repoDir, "rev-parse", BRANCH),
      integrationMessages: await git(target.repoDir, "log", BRANCH, "--format=%B"),
      branchTip: await git(target.repoDir, "rev-parse", call.spec.branch),
      runningBefore: [...running],
    });
    running.add(id);
    arrivals += 1;
    observer.peak = Math.max(observer.peak, running.size);
    if (position <= rendezvous) {
      for (let waited = 0; arrivals < rendezvous && waited < 5000; waited += 10) await pause(10);
    }
    await pause(attemptMs);
    await before(id);
    running.delete(id);
    return behaviour(id);
  });
  const clock = new FakeClock("2026-10-24T08:00:00.000Z");
  const ports = { runner, verifier: new FakeVerifier(), github: target.github, notifier: new FakeNotifier(), clock };
  const run = () => runIssue({ repoDir: target.repoDir, issue: ISSUE, credentials: { "claude-code": TOKEN } }, ports);
  return { observer, runner, run, clock };
}

function writes(directory: string, id: string, content = id): ScriptedAttempt {
  return { files: { [`${directory}${id}.txt`]: `${content}\n` }, commit: `Work on ${id}` };
}

function directoryOf(definitions: SubtaskDefinition[], id: string): string {
  return definitions.find((definition) => definition.id === id)?.scope[0] ?? "";
}

function stateOf(report: { log: RunLog }, id: string) {
  return report.log.subtasks.find((subtask) => subtask.id === id);
}

const BASE: SubtaskDefinition = { id: "B", scope: ["src/"] };

describe("factory run with a base subtask", () => {
  it("should run the base subtask alone and merge it before any other subtask starts", async () => {
    const subtasks = [
      { id: "S1", scope: ["a/"] },
      { id: "S2", scope: ["b/"] },
    ];
    const target = await targetRepo({ base: BASE, subtasks, maxParallel: 2 });
    const { run, observer } = observed(target, (id) => writes(directoryOf([BASE, ...subtasks], id), id), 30);

    const report = await run();

    expect(report.result).toBe("ready");
    expect(observer.order[0]).toBe("B");
    for (const id of ["S1", "S2"]) {
      expect(observer.starts.get(id)?.runningBefore).not.toContain("B");
      expect(observer.starts.get(id)?.integrationMessages).toContain("Factory-Subtask: B");
    }
  });

  it("should gate the base subtask before it merges, as it does any subtask", async () => {
    const subtasks = [{ id: "S1", scope: ["a/"] }];
    const target = await targetRepo({ base: BASE, subtasks });
    const { run, runner } = observed(target, (id) => writes(directoryOf([BASE, ...subtasks], id), id));

    await run();

    const gate = runner.workers.find((worker) => worker.spec.id.includes("-B-gate-"));
    expect(gate?.execs).toEqual([
      { command: "true", exitCode: 0 },
      { command: "true # A1", exitCode: 0 },
    ]);
    expect(runner.workers.indexOf(gate as NonNullable<typeof gate>)).toBeLessThan(
      runner.workers.findIndex((worker) => worker.spec.id === "42-S1"),
    );
  });

  it("should start no other subtask when the base subtask is blocked, saying why", async () => {
    const subtasks = [
      { id: "S1", scope: ["a/"] },
      { id: "S2", scope: ["b/"], dependsOn: ["S1"] },
    ];
    const target = await targetRepo({ base: BASE, subtasks, checkCommand: NO_BAD_FILE });
    const { run, observer } = observed(target, (id) => writes(directoryOf([BASE, ...subtasks], id), id, "BAD"));

    const report = await run();

    expect(report.result).toBe("draft");
    expect([...new Set(observer.order)]).toEqual(["B"]);
    expect(stateOf(report, "B")?.state).toBe("blocked");
    for (const id of ["S1", "S2"]) {
      expect(stateOf(report, id)).toMatchObject({
        state: "not-started",
        reason: "It did not start because the base subtask B is blocked.",
        attempts: [],
      });
    }
    expect(target.github.pullRequests[0]?.body).toContain(
      "**S1** (A2): not-started. It did not start because the base subtask B is blocked.",
    );
  });
});

describe("factory run with several subtasks", () => {
  it("should run the subtasks of a wave at the same time", async () => {
    const subtasks = [
      { id: "S1", scope: ["a/"] },
      { id: "S2", scope: ["b/"] },
    ];
    const target = await targetRepo({ subtasks, maxParallel: 2 });
    const { run, observer } = observed(target, (id) => writes(directoryOf(subtasks, id), id), 0, undefined, 2);

    const report = await run();

    expect(observer.peak).toBe(2);
    expect(report.result).toBe("ready");
    expect(report.log.subtasks.map((subtask) => subtask.state)).toEqual(["merged", "merged"]);
    for (const path of ["a/S1.txt", "b/S2.txt"]) {
      expect(await git(target.repoDir, "show", `${BRANCH}:${path}`)).not.toBe("");
    }
  });

  it("should never run more subtasks at once than maxParallel", async () => {
    const subtasks = [
      { id: "S1", scope: ["a/"] },
      { id: "S2", scope: ["b/"] },
      { id: "S3", scope: ["c/"] },
    ];
    const target = await targetRepo({ subtasks, maxParallel: 2 });
    const { run, observer } = observed(target, (id) => writes(directoryOf(subtasks, id), id), 0, undefined, 2);

    const report = await run();

    expect(observer.peak).toBe(2);
    expect(report.result).toBe("ready");
  });

  it("should run one subtask at a time when maxParallel is 1, each from the integration branch with the previous merge", async () => {
    const subtasks = [
      { id: "S1", scope: ["a/"] },
      { id: "S2", scope: ["b/"] },
      { id: "S3", scope: ["c/"] },
    ];
    const target = await targetRepo({ subtasks, maxParallel: 1 });
    const { run, observer } = observed(target, (id) => writes(directoryOf(subtasks, id), id), 30);

    await run();

    expect(observer.peak).toBe(1);
    const mergeOf = async (id: string) =>
      git(target.repoDir, "log", BRANCH, "--merges", "--grep", `Factory-Subtask: ${id}`, "--format=%H", "-1");
    expect(observer.starts.get("S2")?.branchTip).toBe(await mergeOf("S1"));
    expect(observer.starts.get("S3")?.branchTip).toBe(await mergeOf("S2"));
  });

  it("should start a subtask from the integration branch as it is when the subtask starts, with the merges of the earlier wave", async () => {
    const subtasks = [
      { id: "S1", scope: ["a/"] },
      { id: "S2", scope: ["b/"] },
      { id: "S3", scope: ["c/"], dependsOn: ["S1", "S2"] },
    ];
    const target = await targetRepo({ subtasks, maxParallel: 2 });
    const { run, observer } = observed(target, (id) => writes(directoryOf(subtasks, id), id), 30);

    await run();

    const start = observer.starts.get("S3");
    expect(start?.branchTip).toBe(start?.integrationTip);
    expect(start?.integrationMessages).toContain("Factory-Subtask: S1");
    expect(start?.integrationMessages).toContain("Factory-Subtask: S2");
  });

  it("should run a subtask after the subtask it depends on even when maxParallel would let both run", async () => {
    const subtasks = [
      { id: "S1", scope: ["src/"] },
      { id: "S2", scope: ["src/api/"], dependsOn: ["S1"] },
    ];
    const target = await targetRepo({ subtasks, maxParallel: 2 });
    const { run, observer } = observed(target, (id) => writes(directoryOf(subtasks, id), id), 30);

    await run();

    expect(observer.peak).toBe(1);
    expect(observer.order).toEqual(["S1", "S2"]);
  });

  it("should give the workers that run at the same time different environment slots, and the gate the slot of its subtask", async () => {
    const subtasks = [
      { id: "S1", scope: ["a/"] },
      { id: "S2", scope: ["b/"] },
    ];
    const target = await targetRepo({ subtasks, maxParallel: 2 });
    const { run, runner } = observed(target, (id) => writes(directoryOf(subtasks, id), id), 60);

    await run();

    const envOf = (suffix: string) => runner.workers.find((worker) => worker.spec.id.includes(suffix))?.spec.env;
    expect(envOf("42-S1")).toMatchObject({ E2E_PORT: "4000", DATABASE_URL: "postgres://neon/S1" });
    expect(envOf("42-S2")).toMatchObject({ E2E_PORT: "4001", DATABASE_URL: "postgres://neon/S2" });
    expect(envOf("-S1-gate-")).toEqual({ E2E_PORT: "4000", DATABASE_URL: "postgres://neon/S1" });
    expect(envOf("-S2-gate-")).toEqual({ E2E_PORT: "4001", DATABASE_URL: "postgres://neon/S2" });
    expect(envOf("-verification")).toMatchObject({ E2E_PORT: "4000" });
  });

  it("should not start a subtask that depends on a blocked one, say why, and go on with the others", async () => {
    const subtasks = [
      { id: "S1", scope: ["a/"] },
      { id: "S2", scope: ["b/"], dependsOn: ["S1"] },
      { id: "S3", scope: ["c/"] },
      { id: "S4", scope: ["d/"], dependsOn: ["S2"] },
    ];
    const target = await targetRepo({ subtasks, maxParallel: 2, checkCommand: NO_BAD_FILE });
    const { run, observer } = observed(target, (id) => writes(directoryOf(subtasks, id), id, id === "S1" ? "BAD" : id));

    const report = await run();

    expect(report.result).toBe("draft");
    expect([...new Set(observer.order)].sort()).toEqual(["S1", "S3"]);
    expect(stateOf(report, "S1")?.state).toBe("blocked");
    expect(stateOf(report, "S3")?.state).toBe("merged");
    expect(stateOf(report, "S2")).toMatchObject({
      state: "not-started",
      reason: "It depends on S1, which is blocked.",
      attempts: [],
    });
    expect(stateOf(report, "S4")).toMatchObject({
      state: "not-started",
      reason: "It depends on S2, which did not start.",
    });
    const body = target.github.pullRequests[0]?.body ?? "";
    expect(target.github.pullRequests[0]?.draft).toBe(true);
    expect(body).toContain("**S2** (A2): not-started. It depends on S1, which is blocked.");
    expect(body).toContain("**S4** (A4): not-started. It depends on S2, which did not start.");
    expect(body).toContain("subtasks not merged: S1, S2, S4");
  });

  it("should block the run on a merge conflict, record the conflicting files, and hand the conflict to no agent", async () => {
    const subtasks = [
      { id: "S1", scope: ["a/"] },
      { id: "S2", scope: ["b/"] },
      { id: "S3", scope: ["c/"], dependsOn: ["S1"] },
    ];
    const target = await targetRepo({ subtasks, maxParallel: 2 });
    const commitOutsideTheRun = async () => {
      while (!(await git(target.repoDir, "log", BRANCH, "--format=%B")).includes("Factory-Subtask: S1")) await pause(20);
      while ((await git(target.repoDir, "worktree", "list", "--porcelain")).includes(`refs/heads/${BRANCH}`)) await pause(20);
      await withBranchWorktree(target.repoDir, BRANCH, async (worktree) => {
        await mkdir(join(worktree, "b"), { recursive: true });
        await writeFile(join(worktree, "b", "shared.txt"), "outside\n");
        await git(worktree, "add", ".");
        await git(worktree, "commit", "-q", "-m", "A commit outside the run");
      });
    };
    const { run, runner, observer } = observed(
      target,
      (id) => ({
        files: id === "S2" ? { "b/shared.txt": "S2\n" } : { [`${id === "S1" ? "a" : "c"}/${id}.txt`]: `${id}\n` },
        commit: `Work on ${id}`,
      }),
      0,
      async (id) => (id === "S2" ? commitOutsideTheRun() : undefined),
    );

    const report = await run();

    expect(report.result).toBe("draft");
    expect(stateOf(report, "S1")?.state).toBe("merged");
    expect(stateOf(report, "S2")).toMatchObject({
      state: "blocked",
      conflictFiles: ["b/shared.txt"],
      reason: `Its merge into ${BRANCH} conflicts in b/shared.txt.`,
    });
    expect(stateOf(report, "S2")?.attempts).toHaveLength(1);
    expect(stateOf(report, "S3")).toMatchObject({
      state: "not-started",
      reason: "It did not start because the run stopped on a merge conflict.",
    });
    expect([...observer.order].sort()).toEqual(["S1", "S2"]);
    expect(runner.workers.filter((worker) => worker.attempts.length > 0)).toHaveLength(2);
    expect(target.github.pullRequests[0]?.draft).toBe(true);
    expect(target.github.pullRequests[0]?.body).toContain("**S2** (A2): blocked. Its merge into factory/42-greeting conflicts in b/shared.txt.");
    const onDisk = JSON.parse(await readFile(report.runLogPath, "utf8")) as RunLog;
    expect(onDisk.subtasks.find((subtask) => subtask.id === "S2")?.conflictFiles).toEqual(["b/shared.txt"]);
    expect(await git(target.repoDir, "show", `${BRANCH}:b/shared.txt`)).toBe("outside");
  });

  it("should pause without starting the next subtasks when a worker reaches the plan limit, leaving them pending", async () => {
    const subtasks = [
      { id: "S1", scope: ["a/"] },
      { id: "S2", scope: ["b/"] },
    ];
    const target = await targetRepo({ subtasks, maxParallel: 1 });
    const { run, observer } = observed(target, () => ({ outcome: { kind: "plan-limit", message: "5-hour limit reached" } }));

    const report = await run();

    expect(report.result).toBe("paused");
    expect(observer.order).toEqual(["S1"]);
    expect(report.log.subtasks.map((subtask) => subtask.state)).toEqual(["pending", "pending"]);
  });

  it("should write run.json with every subtask, in the order of the spec, after a run with a base and waves", async () => {
    const subtasks = [
      { id: "S1", scope: ["a/"] },
      { id: "S2", scope: ["b/"], dependsOn: ["S1"] },
    ];
    const target = await targetRepo({ base: BASE, subtasks, maxParallel: 2 });
    const { run } = observed(target, (id) => writes(directoryOf([BASE, ...subtasks], id), id));

    const report = await run();

    const onDisk = JSON.parse(await readFile(report.runLogPath, "utf8")) as RunLog;
    expect(onDisk.subtasks.map((subtask) => [subtask.id, subtask.state])).toEqual([
      ["B", "merged"],
      ["S1", "merged"],
      ["S2", "merged"],
    ]);
    expect(onDisk.result).toBe("ready");
  });
});
