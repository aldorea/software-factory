import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InteractiveLaunch } from "../../src/cli/launch.ts";
import { main, type CliEnv } from "../../src/cli/main.ts";
import type { RoleEntry } from "../../src/cli/role-menu.ts";
import type { RoleChoice } from "../../src/config/config.ts";
import { originHeadProblem } from "../../src/git/repo.ts";
import { execOk } from "../../src/workers/sh.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeGitHub } from "../fakes/github.ts";
import { FakeImageDocker } from "../fakes/image-docker.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeVerifier } from "../fakes/verifier.ts";
import { FakeWorkerRunner } from "../fakes/worker-runner.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

const CONFIG = `export default {
  image: "worker:dev",
  checks: [{ name: "spec", command: "true" }],
  evidence: { request: "true # {{id}}" },
  environment: () => ({}),
  protectedPaths: ["package.json"],
  roles: {
    workers: { agent: "claude-code", model: "sonnet" },
    verifier: { agent: "opencode", model: "opencode-go/kimi-k2" },
    tester: { agent: "claude-code", model: "opus" },
  },
};
`;

async function repo(options: { originHead: boolean }): Promise<string> {
  const remote = await temp.make("readiness-remote-");
  await execOk("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const dir = await temp.make("readiness-target-");
  await execOk("git", ["init", "-q", "-b", "main", dir]);
  await execOk("git", ["-C", dir, "config", "user.name", "t"]);
  await execOk("git", ["-C", dir, "config", "user.email", "t@t"]);
  await execOk("git", ["-C", dir, "remote", "add", "origin", remote]);
  await mkdir(join(dir, ".factory"));
  await writeFile(join(dir, ".factory", "config.ts"), CONFIG);
  await execOk("git", ["-C", dir, "add", "."]);
  await execOk("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  await execOk("git", ["-C", dir, "push", "-q", "origin", "main"]);
  if (options.originHead) await execOk("git", ["-C", dir, "remote", "set-head", "origin", "--auto"]);
  return dir;
}

function cli(cwd: string, overrides: Partial<CliEnv> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const launches: InteractiveLaunch[] = [];
  const runner = new FakeWorkerRunner();
  const env: CliEnv = {
    cwd,
    factoryRoot: "/factory",
    clock: new FakeClock("2026-10-24T08:00:00.000Z"),
    github: () => new FakeGitHub([{ number: 42, title: "x", body: "## Acceptance criteria\n\n- [ ] A1 one\n" }]),
    runner: () => runner,
    verifier: () => new FakeVerifier(),
    notifier: new FakeNotifier(),
    credentials: { "claude-code": "token", opencode: "key" },
    docker: async () => null,
    gh: async () => null,
    claudeSession: async () => null,
    originHead: (repoDir) => originHeadProblem(repoDir),
    launch: async (launch) => {
      launches.push(launch);
      return 0;
    },
    images: new FakeImageDocker(),
    signal: new AbortController().signal,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    ...overrides,
  };
  return { env, out, err, launches, runner };
}

const CLAUDE_REFINEMENT = ["--refinement-agent", "claude-code:sonnet"];

describe("readiness when factory refine starts", () => {
  it("should stop with the problem and its fix, and create no worktree, when the Claude Code session of the host is missing", async () => {
    const dir = await repo({ originHead: true });
    const { env, err, launches } = cli(dir, { claudeSession: async () => "the Claude Code session of this host is not signed in" });

    expect(await main(["refine", "42", ...CLAUDE_REFINEMENT], env)).toBe(1);

    expect(err).toEqual(["✗ the Claude Code session of this host is not signed in → claude auth login"]);
    expect(launches).toEqual([]);
    expect(existsSync(join(dir, ".factory", "worktrees"))).toBe(false);
  });

  it("should stop with the set-head fix, and create no worktree, when origin/HEAD is not set", async () => {
    const dir = await repo({ originHead: false });
    const { env, err, launches } = cli(dir);

    expect(await main(["refine", "42", ...CLAUDE_REFINEMENT], env)).toBe(1);

    expect(err).toEqual(["✗ origin/HEAD is not set → git remote set-head origin --auto"]);
    expect(launches).toEqual([]);
    expect(existsSync(join(dir, ".factory", "worktrees"))).toBe(false);
  });

  it("should list every problem at once, each with its fix", async () => {
    const dir = await repo({ originHead: false });
    const { env, err } = cli(dir, {
      gh: async () => "gh is not signed in",
      claudeSession: async () => "no Claude Code session",
    });

    expect(await main(["refine", "42", ...CLAUDE_REFINEMENT], env)).toBe(1);

    expect(err).toEqual([
      "✗ gh is not signed in → gh auth login",
      "✗ no Claude Code session → claude auth login",
      "✗ origin/HEAD is not set → git remote set-head origin --auto",
    ]);
  });

  it("should ask no role question when it is not ready", async () => {
    const dir = await repo({ originHead: false });
    const asked: RoleEntry[][] = [];
    const { env } = cli(dir, {
      ask: async (entries) => {
        asked.push(entries);
        return {};
      },
    });

    expect(await main(["refine", "42"], env)).toBe(1);

    expect(asked).toEqual([]);
  });

  it("should not look at Docker or the credentials, because refine runs on the host", async () => {
    const dir = await repo({ originHead: true });
    const { env, err, launches } = cli(dir, { docker: async () => "Docker is not running", credentials: {} });

    expect(await main(["refine", "42", ...CLAUDE_REFINEMENT], env)).toBe(0);

    expect(err).toEqual([]);
    expect(launches).toHaveLength(1);
  });
});

describe("readiness when factory run starts", () => {
  it("should stop before the role menu when a flag chooses an agent with no credential", async () => {
    const dir = await repo({ originHead: true });
    const asked: RoleEntry[][] = [];
    const { env, err, runner } = cli(dir, {
      credentials: { "claude-code": "token" },
      ask: async (entries) => {
        asked.push(entries);
        return {};
      },
    });

    const code = await main(["run", "42", "--worker-agent", "opencode:opencode-go/glm-5"], env);

    expect(code).toBe(1);
    expect(err).toEqual([
      "✗ OPENCODE_API_KEY not set; roles.workers and roles.verifier use opencode → factory auth opencode",
    ]);
    expect(asked).toEqual([]);
    expect(runner.workers).toEqual([]);
  });

  it("should stop before the role menu when a value of the config chooses an agent with no credential", async () => {
    const dir = await repo({ originHead: true });
    const asked: RoleEntry[][] = [];
    const { env, err } = cli(dir, {
      credentials: { "claude-code": "token" },
      ask: async (entries) => {
        asked.push(entries);
        return {};
      },
    });

    expect(await main(["run", "42"], env)).toBe(1);

    expect(err).toEqual(["✗ OPENCODE_API_KEY not set; roles.verifier uses opencode → factory auth opencode"]);
    expect(asked).toEqual([]);
  });

  it("should list the tool problems and the credential problems together, each with its fix", async () => {
    const dir = await repo({ originHead: true });
    const { env, err } = cli(dir, { credentials: {}, docker: async () => "Docker is not running", gh: async () => "gh is not signed in" });

    expect(await main(["run", "42"], env)).toBe(1);

    expect(err).toEqual([
      "✗ Docker is not running",
      "✗ gh is not signed in → gh auth login",
      "✗ CLAUDE_CODE_OAUTH_TOKEN not set; roles.workers and roles.tester use claude-code → factory auth claude-code",
      "✗ OPENCODE_API_KEY not set; roles.verifier uses opencode → factory auth opencode",
    ]);
  });

  it("should check again after the menu, so that an agent picked there with no credential stops the run before any worker", async () => {
    const dir = await repo({ originHead: true });
    const { env, err, runner } = cli(dir);
    const picked: RoleChoice = { agent: "opencode", model: "opencode-go/glm-5" };
    env.ask = async () => {
      env.credentials = { "claude-code": "token" };
      return { workers: picked };
    };

    expect(await main(["run", "42"], env)).toBe(1);

    expect(err).toEqual(["✗ OPENCODE_API_KEY not set; roles.workers and roles.verifier use opencode → factory auth opencode"]);
    expect(runner.workers).toEqual([]);
  });

  it("should not check the Claude Code session or origin/HEAD, which belong to refine", async () => {
    const dir = await repo({ originHead: false });
    const { env, err } = cli(dir, { claudeSession: async () => "no session" });

    expect(await main(["run", "42"], env)).toBe(1);

    expect(err.join("\n")).not.toContain("no session");
    expect(err.join("\n")).not.toContain("✗");
  });

  it("should stop with the factory image fix and create no worktree when the worker image was built from an older base image", async () => {
    const dir = await repo({ originHead: true });
    const { env, err, runner } = cli(dir, {
      images: new FakeImageDocker([], "sha256:base-now", { label: "sha256:base-old" }),
    });

    expect(await main(["run", "42"], env)).toBe(1);

    expect(err).toEqual(["✗ worker:dev built from an older base image → factory image"]);
    expect(runner.workers).toEqual([]);
    expect(existsSync(join(dir, ".factory", "worktrees"))).toBe(false);
  });

  it("should stop with the factory image fix when the worker image does not exist", async () => {
    const dir = await repo({ originHead: true });
    const { env, err } = cli(dir, { images: new FakeImageDocker([], undefined, { present: false }) });

    expect(await main(["run", "42"], env)).toBe(1);

    expect(err).toEqual(["✗ worker:dev not built → factory image"]);
  });

  it("should stop with the factory image fix when the worker image has no base image label", async () => {
    const dir = await repo({ originHead: true });
    const { env, err } = cli(dir, { images: new FakeImageDocker([], undefined, { label: null }) });

    expect(await main(["run", "42"], env)).toBe(1);

    expect(err).toEqual([
      "✗ worker:dev has no software-factory.base-image-id label, so it was built by hand → factory image",
    ]);
  });

  it("should list the image problem together with the credential problems", async () => {
    const dir = await repo({ originHead: true });
    const { env, err } = cli(dir, {
      credentials: { "claude-code": "token" },
      images: new FakeImageDocker([], undefined, { present: false }),
    });

    expect(await main(["run", "42"], env)).toBe(1);

    expect(err).toEqual([
      "✗ OPENCODE_API_KEY not set; roles.verifier uses opencode → factory auth opencode",
      "✗ worker:dev not built → factory image",
    ]);
  });

  it("should not report the worker image while Docker is down", async () => {
    const dir = await repo({ originHead: true });
    const { env, err } = cli(dir, {
      docker: async () => "Docker is not running",
      images: new FakeImageDocker([], undefined, { present: false }),
    });

    expect(await main(["run", "42"], env)).toBe(1);

    expect(err).toEqual(["✗ Docker is not running"]);
  });

  it("should show a flag problem together with the readiness problems", async () => {
    const dir = await repo({ originHead: true });
    const { env, err } = cli(dir, { docker: async () => "Docker is not running" });

    expect(await main(["run", "42", "--worker-agent", "gemini:pro"], env)).toBe(1);

    expect(err).toEqual(["✗ Docker is not running", "✗ gemini is not an agent: use one of claude-code, opencode"]);
  });
});
