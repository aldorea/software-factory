import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InteractiveLaunch } from "../../src/cli/launch.ts";
import { main, type CliEnv, type RoleQuestion } from "../../src/cli/main.ts";
import type { RoleChoice } from "../../src/config/config.ts";
import { parseRunLog } from "../../src/coordinator/run-log.ts";
import type { GitHub } from "../../src/github/github.ts";
import { ghGitHub } from "../../src/github/gh.ts";
import { readApproval } from "../../src/spec/approval.ts";
import { dockerProblem } from "../../src/workers/docker.ts";
import { execOk } from "../../src/workers/sh.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeGitHub } from "../fakes/github.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeVerifier } from "../fakes/verifier.ts";
import { FakeWorkerRunner, type AttemptScript } from "../fakes/worker-runner.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

const BRANCH = "factory/42-saved-searches";
const issueBody = "## Acceptance criteria\n\n- [ ] A1 one\n- [ ] A2 two\n- [ ] A3 three\n";

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

function cli(
  cwd: string,
  github: GitHub = new FakeGitHub([{ number: 42, title: "x", body: issueBody }]),
  script?: AttemptScript,
) {
  const out: string[] = [];
  const err: string[] = [];
  const runner = new FakeWorkerRunner(script);
  const notifier = new FakeNotifier();
  const launches: InteractiveLaunch[] = [];
  const env: CliEnv = {
    cwd,
    factoryRoot: "/factory",
    clock: new FakeClock("2026-10-24T08:00:00.000Z"),
    github: () => github,
    runner: () => runner,
    verifier: () => new FakeVerifier(),
    notifier,
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
  return { env, out, err, runner, notifier, launches };
}

const valid = () => readFile(join(import.meta.dirname, "..", "spec", "fixtures", "valid.md"), "utf8");

async function runnableRepo(config: string = CONFIG): Promise<string> {
  const repoDir = await targetRepo(ONE_SUBTASK_SPEC, config);
  const remoteDir = await temp.make("cli-remote-");
  await execOk("git", ["init", "-q", "--bare", remoteDir]);
  await git(repoDir, "remote", "add", "origin", remoteDir);
  await git(repoDir, "branch", "main");
  return repoDir;
}

async function lastRunLog(repoDir: string) {
  const logs = join(repoDir, ".factory", "logs");
  const runId = (await readdir(logs)).sort().at(-1) ?? "";
  const parsed = parseRunLog(await readFile(join(logs, runId, "run.json"), "utf8"));
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.log;
}

const OPUS: RoleChoice = { agent: "claude-code", model: "opus" };
const SONNET: RoleChoice = { agent: "claude-code", model: "sonnet" };
const KIMI: RoleChoice = { agent: "opencode", model: "opencode-go/kimi-k2" };
const GLM: RoleChoice = { agent: "opencode", model: "opencode-go/glm-4.6" };
const NO_ROLES = CONFIG.replace(/  roles: \{[\s\S]*?\n  \},\n/, "");

describe("factory run: the choice of the agent of each role", () => {
  it("should take the agent and the model of each role from the flags over the config default", async () => {
    const repoDir = await runnableRepo();
    const { env } = cli(repoDir);
    expect(await main(["approve", "42"], env)).toBe(0);

    const code = await main(["run", "42", "--worker-agent", "claude-code:opus", "--verifier-agent=opencode:opencode-go/glm-4.6"], env);

    expect(code).toBe(0);
    expect((await lastRunLog(repoDir)).agents).toEqual({ workers: OPUS, verifier: GLM, changes: [] });
  });

  it("should ask in a terminal for each role with no flag, offering only the agents that meet the role and preselecting the config default", async () => {
    const repoDir = await runnableRepo();
    const { env } = cli(repoDir);
    expect(await main(["approve", "42"], env)).toBe(0);
    const questions: RoleQuestion[] = [];
    env.ask = async (question) => {
      questions.push(question);
      return GLM;
    };

    expect(await main(["run", "42", "--worker-agent", "claude-code:opus"], env)).toBe(0);

    expect(questions).toEqual([{ role: "verifier", offered: ["opencode"], preselected: KIMI }]);
    expect((await lastRunLog(repoDir)).agents).toEqual({ workers: OPUS, verifier: GLM, changes: [] });
  });

  it("should take the config default with no flag outside a terminal", async () => {
    const repoDir = await runnableRepo();
    const { env } = cli(repoDir);
    expect(await main(["approve", "42"], env)).toBe(0);

    expect(await main(["run", "42"], env)).toBe(0);

    expect((await lastRunLog(repoDir)).agents).toEqual({ workers: SONNET, verifier: KIMI, changes: [] });
  });

  it("should refuse to start, with no worker, when neither a flag, a prompt nor the config gives the agent of a role", async () => {
    const repoDir = await runnableRepo(NO_ROLES);
    const { env, err, runner } = cli(repoDir);
    expect(await main(["approve", "42"], env)).toBe(0);

    expect(await main(["run", "42", "--worker-agent", "claude-code:sonnet"], env)).toBe(1);

    expect(err.join("\n")).toContain("no agent for the verifier: pass --verifier-agent <agent>:<model> or set roles.verifier");
    expect(runner.workers).toEqual([]);
  });

  it("should refuse before the run starts an agent asked by flag that misses a requirement of the role", async () => {
    const repoDir = await runnableRepo();
    const { env, err, runner } = cli(repoDir);
    expect(await main(["approve", "42"], env)).toBe(0);

    expect(await main(["run", "42", "--worker-agent", "opencode:opencode-go/kimi-k2"], env)).toBe(1);

    expect(err.join("\n")).toContain("opencode cannot serve the workers: it misses detectsPlanLimit");
    expect(runner.workers).toEqual([]);
  });

  it("should ask again on resume with the previous choice preselected, and record the change", async () => {
    const repoDir = await runnableRepo();
    const paused = cli(repoDir, undefined, () => ({ outcome: { kind: "plan-limit", message: "limit" } }));
    expect(await main(["approve", "42"], paused.env)).toBe(0);
    expect(await main(["run", "42", "--worker-agent", "claude-code:opus"], paused.env)).toBe(0);
    expect((await lastRunLog(repoDir)).result).toBe("paused");

    const resumed = cli(repoDir, undefined, () => ({ files: { "src/a.txt": "a\n" } }));
    const questions: RoleQuestion[] = [];
    resumed.env.ask = async (question) => {
      questions.push(question);
      return question.role === "workers" ? SONNET : (question.preselected as RoleChoice);
    };
    expect(await main(["run", "42"], resumed.env)).toBe(0);

    expect(questions.map((question) => [question.role, question.preselected])).toEqual([
      ["workers", OPUS],
      ["verifier", KIMI],
    ]);
    expect((await lastRunLog(repoDir)).agents.changes).toEqual([
      { role: "workers", from: OPUS, to: SONNET, at: "2026-10-24T08:00:00.000Z" },
    ]);
  });

  it("should print the usage on a flag that factory run does not know, or a role flag on another command", async () => {
    const { env, err } = cli(await temp.make("cli-usage-"));

    expect(await main(["run", "42", "--worker", "claude-code"], env)).toBe(2);
    expect(await main(["approve", "42", "--worker-agent", "claude-code:opus"], env)).toBe(2);
    expect(err.join("\n")).toContain("usage: factory");
  });
});

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

  it("should exit non-zero with a clear message, before any worker starts, when Docker is not available", async () => {
    const repoDir = await runnableRepo();
    const { env, err, runner } = cli(repoDir);
    expect(await main(["approve", "42"], env)).toBe(0);

    const code = await main(["run", "42"], { ...env, docker: () => dockerProblem("factory-test-no-such-docker") });

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("factory: Docker is not available");
    expect(runner.workers).toHaveLength(0);
    expect(existsSync(join(repoDir, ".factory", "logs"))).toBe(false);
  });

  it("should exit non-zero before it loads the config, asks any role or starts a worker when gh reports a problem", async () => {
    const repoDir = await temp.make("cli-no-gh-");
    const { env, err, runner } = cli(repoDir);
    const questions: RoleQuestion[] = [];
    env.ask = async (question) => {
      questions.push(question);
      return GLM;
    };

    const code = await main(["run", "42"], { ...env, gh: async () => "gh is not signed in: run gh auth login" });

    expect(code).toBe(1);
    expect(err).toEqual(["factory: gh is not signed in: run gh auth login"]);
    expect(questions).toEqual([]);
    expect(runner.workers).toHaveLength(0);
    expect(existsSync(join(repoDir, ".factory", "logs"))).toBe(false);
  });

  it("should report the Docker and the gh problems together so that every missing tool shows up front", async () => {
    const repoDir = await temp.make("cli-no-tools-");
    const { env, err } = cli(repoDir);

    const code = await main(["run", "42"], { ...env, docker: async () => "Docker is not running", gh: async () => "gh is not available" });

    expect(code).toBe(1);
    expect(err).toEqual(["factory: Docker is not running", "factory: gh is not available"]);
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
