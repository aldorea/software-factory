import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InteractiveLaunch } from "../../src/cli/launch.ts";
import { main, type CliEnv } from "../../src/cli/main.ts";
import type { GitHub } from "../../src/github/github.ts";
import { ghGitHub } from "../../src/github/gh.ts";
import { readApproval } from "../../src/spec/approval.ts";
import { execOk } from "../../src/workers/sh.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeGitHub } from "../fakes/github.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeWorkerRunner } from "../fakes/worker-runner.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

const BRANCH = "factory/42-saved-searches";
const issueBody = "## Acceptance criteria\n\n- [ ] A1 one\n- [ ] A2 two\n- [ ] A3 three\n";

const CONFIG = `export default {
  image: "worker:dev",
  checks: [{ name: "spec", command: "test -f specs/42.md" }],
  environment: () => ({}),
  protectedPaths: ["package.json"],
  roles: {
    workers: { agent: "claude-code", model: "sonnet" },
    verifier: { agent: "opencode", model: "opencode-go/kimi-k2" },
  },
};
`;

const ONE_SUBTASK_SPEC = [
  "# Spec #42",
  "",
  "```json factory-spec",
  JSON.stringify({
    files: { A1: ["src/a.txt"], A2: ["src/a.txt"], A3: ["src/a.txt"] },
    base: null,
    subtasks: [{ id: "S1", criteria: ["A1", "A2", "A3"], scope: ["src/"], dependsOn: [], testChanges: [] }],
    criteria: {
      A1: { evidence: "request", level: "subtask" },
      A2: { evidence: "request", level: "subtask" },
      A3: { evidence: "request", level: "subtask" },
    },
  }),
  "```",
  "",
].join("\n");

async function git(dir: string, ...args: string[]): Promise<string> {
  return (await execOk("git", ["-C", dir, ...args])).trim();
}

async function targetRepo(spec: string, config: string | null = CONFIG): Promise<string> {
  const dir = await temp.make("cli-test-");
  await execOk("git", ["init", "-q", "-b", BRANCH, dir]);
  await git(dir, "config", "user.name", "t");
  await git(dir, "config", "user.email", "t@t");
  await writeFile(join(dir, ".gitignore"), ".factory/logs/\n.factory/worktrees/\n");
  if (config !== null) {
    await mkdir(join(dir, ".factory"));
    await writeFile(join(dir, ".factory", "config.ts"), config);
  }
  await mkdir(join(dir, "specs"));
  await writeFile(join(dir, "specs", "42.md"), spec);
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "Spec #42");
  return dir;
}

async function mainRepo(): Promise<string> {
  const dir = await temp.make("cli-refine-");
  await execOk("git", ["init", "-q", "-b", "main", dir]);
  await git(dir, "config", "user.name", "t");
  await git(dir, "config", "user.email", "t@t");
  await writeFile(join(dir, "README.md"), "# target\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function cli(cwd: string, github: GitHub = new FakeGitHub([{ number: 42, title: "x", body: issueBody }])) {
  const out: string[] = [];
  const err: string[] = [];
  const runner = new FakeWorkerRunner();
  const notifier = new FakeNotifier();
  const launches: InteractiveLaunch[] = [];
  const env: CliEnv = {
    cwd,
    factoryRoot: "/factory",
    clock: new FakeClock("2026-10-24T08:00:00.000Z"),
    github: () => github,
    runner: () => runner,
    notifier,
    credentials: { "claude-code": "token" },
    launch: async (launch) => {
      launches.push(launch);
      return 0;
    },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };
  return { env, out, err, runner, notifier, launches };
}

const valid = () => readFile(join(import.meta.dirname, "..", "spec", "fixtures", "valid.md"), "utf8");

describe("factory CLI", () => {
  it("should exit zero on a valid spec when validating, taking the target repo from the current directory", async () => {
    const repoDir = await targetRepo(await valid());
    const { env, out } = cli(repoDir);

    expect(await main(["validate", "42"], env)).toBe(0);
    expect(out.join("\n")).toContain(`specs/42.md on ${BRANCH} is valid`);
  });

  it("should exit non-zero and list the problems of an invalid spec", async () => {
    const repoDir = await targetRepo("# Spec\n\nNo block.\n");
    const { env, err } = cli(await temp.make("elsewhere-"));

    expect(await main(["validate", "42", repoDir], env)).toBe(1);
    expect(err.join("\n")).toContain("the spec must hold exactly one ```json factory-spec block, found 0");
  });

  it("should validate against the protected paths of the target repo's config", async () => {
    const repoDir = await targetRepo(await valid(), CONFIG.replace('["package.json"]', '["src/search/"]'));
    const { env, err } = cli(repoDir);

    expect(await main(["validate", "42"], env)).toBe(1);
    expect(err.join("\n")).toContain("subtask list has the protected path src/search/ in its scope");
  });

  it("should exit non-zero when the target repo has no config, because validation needs its protected paths", async () => {
    const repoDir = await targetRepo(await valid(), null);
    const { env, err } = cli(repoDir);

    expect(await main(["validate", "42"], env)).toBe(1);
    expect(err.join("\n")).toContain(`${join(repoDir, ".factory", "config.ts")} does not exist`);
  });

  it("should approve a valid spec and say where it committed", async () => {
    const repoDir = await targetRepo(await valid());
    const { env, out } = cli(repoDir);

    expect(await main(["approve", "42"], env)).toBe(0);
    expect(out.join("\n")).toContain(`Approved spec #42 on ${BRANCH}`);
    expect(readApproval(await readFile(join(repoDir, "specs", "42.md"), "utf8")).kind).toBe("approved");
  });

  it("should run an approved spec and print the link of the pull request", async () => {
    const repoDir = await targetRepo(ONE_SUBTASK_SPEC);
    const remoteDir = await temp.make("cli-remote-");
    await execOk("git", ["init", "-q", "--bare", remoteDir]);
    await git(repoDir, "remote", "add", "origin", remoteDir);
    await git(repoDir, "branch", "main");
    const { env, out, notifier } = cli(repoDir);
    expect(await main(["approve", "42"], env)).toBe(0);

    expect(await main(["run", "42"], env)).toBe(0);

    expect(out.join("\n")).toContain("Run 42-2026-10-24T08-00-00-000Z: ready, https://github.test/pull/100");
    expect(notifier.sent).toHaveLength(1);
  });

  it("should exit non-zero and start no worker when the spec to run is not approved", async () => {
    const repoDir = await targetRepo(ONE_SUBTASK_SPEC);
    const { env, err, runner } = cli(repoDir);

    expect(await main(["run", "42"], env)).toBe(1);
    expect(err.join("\n")).toContain("specs/42.md is not approved; run factory approve 42 first");
    expect(runner.workers).toEqual([]);
  });

  it("should exit non-zero with a clear message when the integration branch does not exist", async () => {
    const repoDir = await targetRepo(await valid());
    const { env, err } = cli(repoDir);

    expect(await main(["approve", "7"], env)).toBe(1);
    expect(err.join("\n")).toContain("no integration branch factory/7-<slug>");
  });

  it("should exit non-zero with a clear message when gh is missing", async () => {
    const repoDir = await targetRepo(await valid());
    const { env, err } = cli(repoDir, ghGitHub({ repoDir, command: "factory-test-no-such-gh" }));

    expect(await main(["validate", "42"], env)).toBe(1);
    expect(err.join("\n")).toContain("gh is not available");
  });

  it("should print the usage and exit non-zero on an unknown command or a bad issue number", async () => {
    const { env, err } = cli(await temp.make("cli-usage-"));

    expect(await main(["deploy", "42"], env)).toBe(2);
    expect(await main(["approve", "forty-two"], env)).toBe(2);
    expect(err.join("\n")).toContain("usage: factory <refine|approve|validate|run> <issue> [target-repo]");
  });

  it("should prepare the worktree and launch the refinement in it, exiting with the code of the session", async () => {
    const repoDir = await mainRepo();
    const { env, out, launches } = cli(repoDir, new FakeGitHub([{ number: 42, title: "Saved searches", body: "" }]));
    env.launch = async (launch) => {
      launches.push(launch);
      return 7;
    };

    expect(await main(["refine", "42"], env)).toBe(7);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.cwd).toBe(join(repoDir, ".factory", "worktrees", "42-saved-searches"));
    expect(launches[0]?.args).toContain("/factory:refine 42");
    expect(out.join("\n")).toContain("Created factory/42-saved-searches");
  });

  it("should say that it reuses the branch and launch again when the worktree already exists", async () => {
    const repoDir = await mainRepo();
    const { env, out, launches } = cli(repoDir, new FakeGitHub([{ number: 42, title: "Saved searches", body: "" }]));

    expect(await main(["refine", "42"], env)).toBe(0);
    expect(await main(["refine", "42"], env)).toBe(0);
    expect(launches).toHaveLength(2);
    expect(out.join("\n")).toContain("Reusing factory/42-saved-searches");
  });

  it("should not launch when the issue cannot be read", async () => {
    const { env, err, launches } = cli(await mainRepo(), new FakeGitHub([]));

    expect(await main(["refine", "42"], env)).toBe(1);
    expect(launches).toHaveLength(0);
    expect(err.join("\n")).toContain("issue #42 does not exist");
  });
});
