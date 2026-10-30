import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InteractiveLaunch } from "../../src/cli/launch.ts";
import { main, type CliEnv } from "../../src/cli/main.ts";
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
    refinement: { agent: "claude-code", model: "opus" },
  },
};
`;

const ENV_EXAMPLE = "FACTORY_E2E_DATABASE_URL_0=\nFACTORY_E2E_DATABASE_URL_1=\n";
const ENV_FILLED = "FACTORY_E2E_DATABASE_URL_0=postgres://a\nFACTORY_E2E_DATABASE_URL_1=postgres://b\n";

async function repo(options: { config?: string; env?: string | null; originHead?: boolean } = {}): Promise<string> {
  const remote = await temp.make("doctor-remote-");
  await execOk("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const dir = await temp.make("doctor-target-");
  await execOk("git", ["init", "-q", "-b", "main", dir]);
  await execOk("git", ["-C", dir, "config", "user.name", "t"]);
  await execOk("git", ["-C", dir, "config", "user.email", "t@t"]);
  await execOk("git", ["-C", dir, "remote", "add", "origin", remote]);
  await mkdir(join(dir, ".factory"));
  await writeFile(join(dir, ".factory", "config.ts"), options.config ?? CONFIG);
  await writeFile(join(dir, ".factory", ".env.example"), ENV_EXAMPLE);
  if (options.env !== null) await writeFile(join(dir, ".factory", ".env"), options.env ?? ENV_FILLED);
  await execOk("git", ["-C", dir, "add", "."]);
  await execOk("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  await execOk("git", ["-C", dir, "push", "-q", "origin", "main"]);
  if (options.originHead !== false) await execOk("git", ["-C", dir, "remote", "set-head", "origin", "--auto"]);
  return dir;
}

async function factoryRoot(floor: string): Promise<string> {
  const dir = await temp.make("doctor-factory-");
  await writeFile(join(dir, "package.json"), JSON.stringify({ engines: { node: floor } }));
  return dir;
}

async function cli(cwd: string, overrides: Partial<CliEnv> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const launches: InteractiveLaunch[] = [];
  const runner = new FakeWorkerRunner();
  const github = new FakeGitHub([]);
  const images = overrides.images ?? new FakeImageDocker();
  const env: CliEnv = {
    cwd,
    factoryRoot: await factoryRoot(">=1.0.0"),
    clock: new FakeClock("2026-10-24T08:00:00.000Z"),
    github: () => github,
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
    images,
    signal: new AbortController().signal,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    ...overrides,
  };
  return { env, out, err, launches, runner, images: images as FakeImageDocker };
}

async function snapshot(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.filter((entry) => entry !== ".git" && !entry.startsWith(".git/")).sort();
}

describe("factory doctor", () => {
  it("should list every check with a tick and exit with 0 when the host and the repo are ready", async () => {
    const dir = await repo();
    const { env, out, err } = await cli(dir);

    expect(await main(["doctor"], env)).toBe(0);

    expect(err).toEqual([]);
    expect(out).toEqual([
      "✓ Node is at the floor of engines in package.json",
      "✓ Docker is running",
      "✓ gh is signed in",
      "✓ the Claude Code session of the host is signed in",
      "✓ .factory/config.ts loads",
      "✓ .factory/.env has every value of .factory/.env.example",
      "✓ origin/HEAD is set",
      "✓ CLAUDE_CODE_OAUTH_TOKEN is set for claude-code",
      "✓ OPENCODE_API_KEY is set for opencode",
      "✓ the worker image is built from the current base image",
    ]);
  });

  it("should take the target repo from the last argument", async () => {
    const dir = await repo();
    const { env, out } = await cli(await temp.make("doctor-elsewhere-"));

    expect(await main(["doctor", dir], env)).toBe(0);

    expect(out).toContain("✓ .factory/config.ts loads");
  });

  it("should list every problem with its fix, not only the first, and exit with 1", async () => {
    const dir = await repo({ env: "FACTORY_E2E_DATABASE_URL_0=postgres://a\n" });
    const { env, out } = await cli(dir, {
      credentials: { "claude-code": "token" },
      images: new FakeImageDocker([], undefined, { label: "sha256:00000000000000000000000000000000" }),
    });

    expect(await main(["doctor"], env)).toBe(1);

    expect(out.filter((line) => line.startsWith("✗"))).toEqual([
      "✗ .factory/.env has no value for FACTORY_E2E_DATABASE_URL_1 → edit .factory/.env",
      "✗ OPENCODE_API_KEY not set; roles.verifier uses opencode → factory auth opencode",
      "✗ worker:dev built from an older base image → factory image",
    ]);
    expect(out.filter((line) => line.startsWith("✓"))).toHaveLength(7);
  });

  it("should not check the credential of the refinement, because it runs on the host session", async () => {
    const dir = await repo({
      config: CONFIG.replace(
        /workers: \{[^}]*\}/,
        'workers: { agent: "opencode", model: "opencode-go/kimi-k2" }',
      ).replace(/tester: \{[^}]*\}/, 'tester: { agent: "opencode", model: "opencode-go/kimi-k2" }'),
    });
    const { env, out } = await cli(dir, { credentials: { opencode: "key" } });

    expect(await main(["doctor"], env)).toBe(0);

    expect(out.some((line) => line.includes("CLAUDE_CODE_OAUTH_TOKEN"))).toBe(false);
  });

  it("should report a .factory/.env that does not exist with the copy command", async () => {
    const dir = await repo({ env: null });
    const { env, out } = await cli(dir);

    expect(await main(["doctor"], env)).toBe(1);

    expect(out).toContain(
      "✗ .factory/.env does not exist; .factory/.env.example lists FACTORY_E2E_DATABASE_URL_0, FACTORY_E2E_DATABASE_URL_1 → cp .factory/.env.example .factory/.env",
    );
  });

  it("should report a config that does not load and not guess the worker image", async () => {
    const dir = await repo({ config: "export default { image: 3 };\n" });
    const { env, out } = await cli(dir);

    expect(await main(["doctor"], env)).toBe(1);

    expect(out.filter((line) => line.startsWith("✗"))).toHaveLength(1);
    expect(out.join("\n")).toContain("is invalid");
    expect(out.join("\n")).not.toContain("worker image");
  });

  it("should report origin/HEAD that is not resolved with the set-head command", async () => {
    const dir = await repo({ originHead: false });
    const { env, out } = await cli(dir);

    expect(await main(["doctor"], env)).toBe(1);

    expect(out).toContain("✗ origin/HEAD is not set → git remote set-head origin --auto");
  });

  it("should report a Node older than the floor of engines in the package.json of the factory", async () => {
    const dir = await repo();
    const { env, out } = await cli(dir, { factoryRoot: await factoryRoot(">=999.0.0") });

    expect(await main(["doctor"], env)).toBe(1);

    expect(out[0]).toBe(`✗ Node ${process.versions.node} is older than 999.0.0, the floor of engines in package.json`);
  });

  it("should show a broken credentials file as a failed check with its fix and not crash", async () => {
    const dir = await repo();
    const { env, out } = await cli(dir, {
      credentials: {},
      credentialsProblem: { problem: "/c/credentials can be read by other users (mode 644)", fix: "chmod 600 /c/credentials" },
    });

    expect(await main(["doctor"], env)).toBe(1);

    expect(out).toContain("✗ /c/credentials can be read by other users (mode 644) → chmod 600 /c/credentials");
    expect(out.some((line) => line.includes("not set"))).toBe(false);
  });

  it("should skip the worker image and name the Docker problem when Docker is down", async () => {
    const dir = await repo();
    const { env, out } = await cli(dir, { docker: async () => "Docker is not running" });

    expect(await main(["doctor"], env)).toBe(1);

    expect(out).toContain("✗ Docker is not running");
    expect(out.some((line) => line.includes("worker image"))).toBe(false);
  });

  it("should create no worktree, write no file and start no container or build", async () => {
    const dir = await repo({ env: null });
    const before = await snapshot(dir);
    const { env, runner, launches, images } = await cli(dir, { credentials: {} });

    expect(await main(["doctor"], env)).toBe(1);

    expect(await snapshot(dir)).toEqual(before);
    expect(runner.workers).toEqual([]);
    expect(launches).toEqual([]);
    expect(images.builds).toEqual([]);
  });

  it("should refuse the factory itself, like every command that takes a target repo", async () => {
    const root = await factoryRoot(">=1.0.0");
    const { env, err, out } = await cli(root, { factoryRoot: root });

    expect(await main(["doctor"], env)).toBe(1);

    expect(err.join("\n")).toContain("is the factory itself");
    expect(out).toEqual([]);
  });

  it("should refuse a folder inside .factory/worktrees/ of a repo", async () => {
    const dir = await repo();
    const inside = join(dir, ".factory", "worktrees", "12-x");
    await mkdir(inside, { recursive: true });
    const { env, err, out } = await cli(inside);

    expect(await main(["doctor"], env)).toBe(1);

    expect(err.join("\n")).toContain(".factory/worktrees/");
    expect(out).toEqual([]);
  });

  it("should print the usage and exit with 2 on more than one argument", async () => {
    const { env, err } = await cli(await temp.make("doctor-usage-"));

    expect(await main(["doctor", "a", "b"], env)).toBe(2);

    expect(err.join("\n")).toContain("usage: factory");
  });
});

describe("factory --help", () => {
  it("should list auth, image and doctor with one line each", async () => {
    const { env, out, err } = await cli(await temp.make("doctor-help-"));

    expect(await main(["--help"], env)).toBe(0);

    expect(err).toEqual([]);
    const lines = out.join("\n").split("\n");
    expect(lines.filter((line) => line.includes("factory auth"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("factory image"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("factory doctor"))).toHaveLength(1);
  });
});
