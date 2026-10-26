import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InteractiveLaunch } from "../../src/cli/launch.ts";
import { main, type CliEnv } from "../../src/cli/main.ts";
import { execOk } from "../../src/workers/sh.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeGitHub } from "../fakes/github.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeVerifier } from "../fakes/verifier.ts";
import { FakeWorkerRunner } from "../fakes/worker-runner.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

const BRANCH = "factory/42-saved-searches";
const ISSUE_BODY = "## Acceptance criteria\n\n- [ ] A1 one\n";

const CONFIG = `export default {
  image: "worker:dev",
  checks: [{ name: "spec", command: "test -f specs/42.md" }],
  evidence: { request: "test -f specs/42.md # {{id}}" },
  environment: () => ({}),
  protectedPaths: ["package.json"],
  roles: {
    workers: { agent: "claude-code", model: "sonnet" },
    verifier: { agent: "opencode", model: "opencode-go/kimi-k2" },
  },
};
`;

const SPEC = [
  "# Spec #42",
  "",
  "```json factory-spec",
  JSON.stringify({
    files: { A1: ["src/a.txt"] },
    base: null,
    subtasks: [{ id: "S1", criteria: ["A1"], scope: ["src/"], dependsOn: [], testChanges: [] }],
    criteria: { A1: { evidence: "request", level: "subtask" } },
  }),
  "```",
  "",
].join("\n");

async function git(dir: string, ...args: string[]): Promise<string> {
  return (await execOk("git", ["-C", dir, ...args])).trim();
}

interface TrunkOptions {
  setHead?: boolean;
  localCopy?: boolean;
  withSpec?: boolean;
}

async function trunkRepo(options: TrunkOptions = {}): Promise<string> {
  const { setHead = true, localCopy = true, withSpec = true } = options;
  const remoteDir = await temp.make("default-branch-remote-");
  await execOk("git", ["init", "-q", "--bare", "-b", "trunk", remoteDir]);
  const repoDir = await temp.make("default-branch-target-");
  await execOk("git", ["init", "-q", "-b", "trunk", repoDir]);
  await git(repoDir, "config", "user.name", "t");
  await git(repoDir, "config", "user.email", "t@t");
  await git(repoDir, "remote", "add", "origin", remoteDir);
  await writeFile(join(repoDir, ".gitignore"), ".factory/logs/\n.factory/worktrees/\n");
  await mkdir(join(repoDir, ".factory"));
  await writeFile(join(repoDir, ".factory", "config.ts"), CONFIG);
  await git(repoDir, "add", ".");
  await git(repoDir, "commit", "-q", "-m", "init");
  await git(repoDir, "push", "-q", "origin", "trunk");
  if (setHead) await git(repoDir, "remote", "set-head", "origin", "--auto");
  if (withSpec) {
    await git(repoDir, "switch", "-q", "-c", BRANCH);
    await mkdir(join(repoDir, "specs"));
    await writeFile(join(repoDir, "specs", "42.md"), SPEC);
    await git(repoDir, "add", ".");
    await git(repoDir, "commit", "-q", "-m", "Spec #42");
    await git(repoDir, "switch", "-q", "trunk");
  }
  await git(repoDir, "commit", "-q", "--allow-empty", "-m", "local only");
  if (!localCopy) {
    await git(repoDir, "switch", "-q", "-c", "elsewhere");
    await git(repoDir, "branch", "-D", "trunk");
  }
  return repoDir;
}

function cli(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const runner = new FakeWorkerRunner(() => ({ files: { "src/a.txt": "a\n" } }));
  const github = new FakeGitHub([{ number: 42, title: "Saved searches", body: ISSUE_BODY }]);
  const launches: InteractiveLaunch[] = [];
  const env: CliEnv = {
    cwd,
    factoryRoot: "/factory",
    clock: new FakeClock("2026-10-24T08:00:00.000Z"),
    github: () => github,
    runner: () => runner,
    verifier: () => new FakeVerifier(),
    notifier: new FakeNotifier(),
    credentials: { "claude-code": "token", opencode: "key" },
    docker: async () => null,
    gh: async () => null,
    launch: async (launch) => {
      launches.push(launch);
      return 0;
    },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };
  return { env, out, err, runner, github, launches };
}

describe("default branch of the target repo", () => {
  it("should start the integration branch of refine from the local copy of the default branch, with no fetch, when origin/HEAD is trunk", async () => {
    const repoDir = await trunkRepo({ withSpec: false });
    const localTrunk = await git(repoDir, "rev-parse", "trunk");
    const remoteTrunk = await git(repoDir, "rev-parse", "origin/trunk");
    const { env, launches } = cli(repoDir);

    expect(await main(["refine", "42"], env)).toBe(0);

    expect(localTrunk).not.toBe(remoteTrunk);
    expect(await git(repoDir, "rev-parse", BRANCH)).toBe(localTrunk);
    expect(launches).toHaveLength(1);
  });

  it("should ask GitHub for a pull request whose base is the default branch when running", async () => {
    const repoDir = await trunkRepo();
    const { env, github } = cli(repoDir);
    expect(await main(["approve", "42"], env)).toBe(0);

    expect(await main(["run", "42"], env)).toBe(0);

    expect(github.pullRequests.map((pullRequest) => [pullRequest.head, pullRequest.base])).toEqual([[BRANCH, "trunk"]]);
  });

  it("should fail refine with the set-head command in the message when origin/HEAD is not set", async () => {
    const repoDir = await trunkRepo({ setHead: false, withSpec: false });
    const { env, err, launches } = cli(repoDir);

    expect(await main(["refine", "42"], env)).toBe(1);

    expect(err.join("\n")).toContain("git remote set-head origin --auto");
    expect(launches).toHaveLength(0);
  });

  it("should fail run with the set-head command in the message, before any worker starts, when origin/HEAD is not set", async () => {
    const repoDir = await trunkRepo({ setHead: false });
    const { env, err, runner, github } = cli(repoDir);
    expect(await main(["approve", "42"], env)).toBe(0);

    expect(await main(["run", "42"], env)).toBe(1);

    expect(err.join("\n")).toContain("git remote set-head origin --auto");
    expect(runner.workers).toEqual([]);
    expect(github.pullRequests).toEqual([]);
  });

  it("should fail refine saying that the default branch has no local copy", async () => {
    const repoDir = await trunkRepo({ localCopy: false, withSpec: false });
    const { env, err, launches } = cli(repoDir);

    expect(await main(["refine", "42"], env)).toBe(1);

    expect(err.join("\n")).toContain("default branch trunk has no local copy");
    expect(err.join("\n")).not.toContain("set-head");
    expect(launches).toHaveLength(0);
  });

  it("should fail run saying that the default branch has no local copy, before any worker starts", async () => {
    const repoDir = await trunkRepo({ localCopy: false });
    const { env, err, runner } = cli(repoDir);
    expect(await main(["approve", "42"], env)).toBe(0);

    expect(await main(["run", "42"], env)).toBe(1);

    expect(err.join("\n")).toContain("default branch trunk has no local copy");
    expect(runner.workers).toEqual([]);
  });
});
