import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, type CliEnv } from "../../src/cli/main.ts";
import { loadConfig } from "../../src/config/load.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeGitHub } from "../fakes/github.ts";
import { FakeImageDocker } from "../fakes/image-docker.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeVerifier } from "../fakes/verifier.ts";
import { FakeWorkerRunner } from "../fakes/worker-runner.ts";
import { dockerignoreProblem } from "../../src/workers/dockerignore.ts";
import { execOk } from "../../src/workers/sh.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

function cli(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const env: CliEnv = {
    cwd,
    factoryRoot: "/factory",
    clock: new FakeClock("2026-10-24T08:00:00.000Z"),
    github: () => new FakeGitHub([]),
    runner: () => new FakeWorkerRunner(),
    verifier: () => new FakeVerifier(),
    notifier: new FakeNotifier(),
    credentials: {},
    docker: async () => null,
    gh: async () => null,
    claudeSession: async () => null,
    originHead: async () => null,
    launch: async () => 0,
    images: new FakeImageDocker([], null),
    signal: new AbortController().signal,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };
  return { env, out, err };
}

interface RepoOptions {
  name?: string;
  origin?: boolean;
  files?: Record<string, string>;
}

async function targetRepo(options: RepoOptions = {}): Promise<string> {
  const parent = await temp.make("init-parent-");
  const dir = join(parent, options.name ?? "toy");
  await mkdir(dir);
  await execOk("git", ["init", "-q", "-b", "main", dir]);
  if (options.origin ?? true) await execOk("git", ["-C", dir, "remote", "add", "origin", "https://example.invalid/toy.git"]);
  for (const [path, content] of Object.entries(options.files ?? {})) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

const manifest = (scripts: Record<string, string>) => JSON.stringify({ name: "toy", scripts }, null, 2) + "\n";

describe("factory init", () => {
  it("should refuse to run outside a git repo and write nothing", async () => {
    const dir = await temp.make("init-no-git-");
    const { env, err } = cli(dir);

    expect(await main(["init"], env)).toBe(1);
    expect(err.join("\n")).toContain("not a git repo");
    expect(await readdir(dir)).toEqual([]);
  });

  it("should refuse to run in a repo with no origin and write nothing, so a missing default branch shows up before refine or run", async () => {
    const dir = await targetRepo({ origin: false, files: { "pnpm-lock.yaml": "" } });
    const { env, err } = cli(dir);

    expect(await main(["init"], env)).toBe(1);
    expect(err.join("\n")).toContain("no origin");
    expect(existsSync(join(dir, ".factory"))).toBe(false);
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });

  it("should refuse to run in a folder inside a repo, because .factory belongs at the root", async () => {
    const dir = await targetRepo();
    await mkdir(join(dir, "packages"));
    const { env, err } = cli(join(dir, "packages"));

    expect(await main(["init"], env)).toBe(1);
    expect(err.join("\n")).toContain("not a git repo, or not its root");
    expect(await readdir(join(dir, "packages"))).toEqual([]);
  });

  it("should write every file in a pnpm repo, with the install check first and then the lint and test scripts that exist", async () => {
    const dir = await targetRepo({
      name: "toy",
      files: { "pnpm-lock.yaml": "", "package.json": manifest({ test: "vitest", build: "tsc", lint: "eslint ." }) },
    });
    const { env, out, err } = cli(dir);

    expect(await main(["init"], env)).toBe(0);

    expect(err).toEqual([]);
    expect(out.slice(0, 6)).toEqual([
      "✓ wrote .factory/config.ts",
      "✓ wrote .factory/Dockerfile",
      "✓ wrote .factory/.dockerignore",
      "✓ wrote .factory/.env.example",
      "✓ wrote .factory/package.json",
      "✓ wrote .gitignore",
    ]);
    const config = await loadConfig(dir);
    expect(config.image).toBe("toy-factory-worker:dev");
    expect(config.checks).toEqual([
      { name: "install", command: "pnpm install --frozen-lockfile" },
      { name: "lint", command: "pnpm lint" },
      { name: "test", command: "pnpm test" },
    ]);
    expect(await readFile(join(dir, ".factory", "Dockerfile"), "utf8")).toContain("pnpm");
    expect(await readFile(join(dir, ".factory", "package.json"), "utf8")).toContain('"type": "module"');
  });

  it("should write a .factory/.dockerignore that excludes .env, so the build context of the worker image never holds the secrets of the repo", async () => {
    const dir = await targetRepo({ files: { "pnpm-lock.yaml": "" } });
    const { env } = cli(dir);

    expect(await main(["init"], env)).toBe(0);

    expect(dockerignoreProblem(await readFile(join(dir, ".factory", ".dockerignore"), "utf8"))).toBeNull();
  });

  it("should never overwrite an existing .factory/.dockerignore, even one that does not exclude .env", async () => {
    const dir = await targetRepo({ files: { "pnpm-lock.yaml": "", ".factory/.dockerignore": "node_modules\n" } });
    const { env, out } = cli(dir);

    expect(await main(["init"], env)).toBe(0);

    expect(out).toContain("✓ skipped .factory/.dockerignore (already exists)");
    expect(await readFile(join(dir, ".factory", ".dockerignore"), "utf8")).toBe("node_modules\n");
  });

  it("should install with npm ci in an npm repo and run the scripts with npm run", async () => {
    const dir = await targetRepo({
      files: { "package-lock.json": "{}", "package.json": manifest({ typecheck: "tsc", test: "vitest" }) },
    });
    const { env } = cli(dir);

    expect(await main(["init"], env)).toBe(0);

    expect((await loadConfig(dir)).checks).toEqual([
      { name: "install", command: "npm ci" },
      { name: "typecheck", command: "npm run typecheck" },
      { name: "test", command: "npm run test" },
    ]);
    expect(await readFile(join(dir, ".factory", "Dockerfile"), "utf8")).not.toContain("pnpm");
  });

  it("should write no install check when no lockfile is recognised", async () => {
    const dir = await targetRepo({ files: { "yarn.lock": "", "package.json": manifest({ test: "vitest" }) } });
    const { env } = cli(dir);

    expect(await main(["init"], env)).toBe(0);

    expect((await loadConfig(dir)).checks).toEqual([{ name: "test", command: "npm run test" }]);
  });

  it("should name the image after the repo folder, lowercased because Docker refuses uppercase names", async () => {
    const dir = await targetRepo({ name: "My App", files: { "pnpm-lock.yaml": "" } });
    const { env } = cli(dir);

    expect(await main(["init"], env)).toBe(0);

    expect((await readFile(join(dir, ".factory", "config.ts"), "utf8"))).toContain('image: "my-app-factory-worker:dev"');
  });

  it("should write only the missing files, report the others as skipped and never overwrite, so a second run writes nothing", async () => {
    const dir = await targetRepo({
      files: {
        "pnpm-lock.yaml": "",
        "package.json": manifest({ test: "vitest" }),
        ".factory/Dockerfile": "FROM mine\n",
        ".gitignore": "node_modules\n.factory/logs/\n.factory/worktrees/\n.factory/.env\n",
      },
    });
    const { env, out } = cli(dir);

    expect(await main(["init"], env)).toBe(0);

    expect(out.slice(0, 6)).toEqual([
      "✓ wrote .factory/config.ts",
      "✓ skipped .factory/Dockerfile (already exists)",
      "✓ wrote .factory/.dockerignore",
      "✓ wrote .factory/.env.example",
      "✓ wrote .factory/package.json",
      "✓ skipped .gitignore (already lists the factory entries)",
    ]);
    expect(await readFile(join(dir, ".factory", "Dockerfile"), "utf8")).toBe("FROM mine\n");

    const second = cli(dir);
    expect(await main(["init"], second.env)).toBe(0);
    expect(second.out.slice(0, 6).every((line) => line.startsWith("✓ skipped "))).toBe(true);
  });

  it("should leave package.json of the target repo byte for byte unchanged", async () => {
    const original = '{"name":"toy",  "scripts":{"lint":"x","test":"y"}}';
    const dir = await targetRepo({ files: { "pnpm-lock.yaml": "", "package.json": original } });
    const { env } = cli(dir);

    expect(await main(["init"], env)).toBe(0);

    expect(await readFile(join(dir, "package.json"), "utf8")).toBe(original);
  });

  it("should add to .gitignore only the entries that are missing, keeping what was there", async () => {
    const dir = await targetRepo({ files: { "pnpm-lock.yaml": "", ".gitignore": "node_modules\n.factory/logs/" } });
    const { env, out } = cli(dir);

    expect(await main(["init"], env)).toBe(0);

    expect(out).toContain("✓ updated .gitignore");
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe("node_modules\n.factory/logs/\n.factory/worktrees/\n.factory/.env\n");
  });

  it("should treat /.factory/logs/ with a leading slash as already ignored, so .gitignore gets no duplicate of it", async () => {
    const dir = await targetRepo({ files: { "pnpm-lock.yaml": "", ".gitignore": "/.factory/logs/\n" } });
    const { env } = cli(dir);

    expect(await main(["init"], env)).toBe(0);

    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe("/.factory/logs/\n.factory/worktrees/\n.factory/.env\n");
  });

  it("should take the target repo from the argument", async () => {
    const dir = await targetRepo({ files: { "pnpm-lock.yaml": "", "package.json": manifest({ test: "vitest" }) } });
    const { env, err } = cli(await temp.make("init-elsewhere-"));

    expect(await main(["init", dir], env)).toBe(0);
    expect(err).toEqual([]);
    expect(existsSync(join(dir, ".factory", "config.ts"))).toBe(true);
  });

  it("should paint the written files in green when the environment says colour is on", async () => {
    const dir = await targetRepo({ files: { "pnpm-lock.yaml": "" } });
    const { env, out } = cli(dir);

    expect(await main(["init"], { ...env, color: true }), "exit code").toBe(0);

    expect(out[0]).toBe(`\u001b[1;92m✓\u001b[0m wrote .factory/config.ts`);
  });

  it("should print no ANSI code when the environment says colour is off", async () => {
    const dir = await targetRepo({ files: { "pnpm-lock.yaml": "" } });
    const { env, out } = cli(dir);

    expect(await main(["init"], { ...env, color: false })).toBe(0);

    expect(out.join("\n")).not.toMatch(/\u001b\[/);
  });

  it("should end with the Next: list of a fresh repo, naming the variables of .env.example and the worker image", async () => {
    const dir = await targetRepo({ name: "toy", files: { "pnpm-lock.yaml": "" } });
    const { env, out } = cli(dir);

    expect(await main(["init"], env)).toBe(0);

    expect(out.slice(6)).toEqual([
      "Next:",
      "  1. fill .factory/.env (copy of .env.example: FACTORY_E2E_DATABASE_URL_0, FACTORY_E2E_DATABASE_URL_1)",
      "  2. factory auth          set the credential of each agent, once for every repo",
      "  3. factory image         build the base image and toy-factory-worker:dev",
      "  4. factory doctor        check that everything is ready",
      "  5. factory refine <n>",
    ]);
  });

  it("should mark the credential step with a tick when the credential of the default roles is already saved", async () => {
    const dir = await targetRepo({ files: { "pnpm-lock.yaml": "" } });
    const { env, out } = cli(dir);

    expect(await main(["init"], { ...env, credentials: { "claude-code": "sk-ant-oat01-saved" } })).toBe(0);

    expect(out).toContain("✓ 2. factory auth          set the credential of each agent, once for every repo");
  });

  it("should mark the image step with a tick when the worker image exists", async () => {
    const dir = await targetRepo({ files: { "pnpm-lock.yaml": "" } });
    const { env, out } = cli(dir);

    expect(await main(["init"], { ...env, images: new FakeImageDocker() })).toBe(0);

    expect(out.some((line) => line.startsWith("✓ 3. factory image"))).toBe(true);
  });

  it("should ask the image probe for the image name of the config, not a guessed one", async () => {
    const config =
      'export default { image: "custom:1", checks: [{ name: "t", command: "t" }], environment: () => ({}), protectedPaths: [] };\n';
    const dir = await targetRepo({ files: { "pnpm-lock.yaml": "", ".factory/config.ts": config } });
    const asked: string[] = [];
    const { env, out } = cli(dir);
    const images = {
      user: { uid: 501, gid: 20 },
      build: async () => 0,
      label: async () => null,
      id: async (reference: string) => {
        asked.push(reference);
        return null;
      },
    };

    expect(await main(["init"], { ...env, images })).toBe(0);

    expect(asked).toEqual(["custom:1"]);
    expect(out.join("\n")).toContain("build the base image and custom:1");
  });

  it("should still succeed and show the image step as not done when Docker cannot be asked", async () => {
    const dir = await targetRepo({ files: { "pnpm-lock.yaml": "" } });
    const { env, out } = cli(dir);
    const images = {
      user: { uid: 501, gid: 20 },
      build: async () => 0,
      label: async () => null,
      id: async () => {
        throw new Error("docker is not installed or not on the PATH");
      },
    };

    expect(await main(["init"], { ...env, images })).toBe(0);

    expect(out.some((line) => line.startsWith("  3. factory image"))).toBe(true);
  });

  it("should mark the .env step with a tick when .factory/.env already gives a value to every variable", async () => {
    const dir = await targetRepo({
      files: {
        "pnpm-lock.yaml": "",
        ".factory/.env.example": "FACTORY_E2E_DATABASE_URL_0=\nFACTORY_E2E_DATABASE_URL_1=\n",
        ".factory/.env": "FACTORY_E2E_DATABASE_URL_0=a\nFACTORY_E2E_DATABASE_URL_1=b\n",
      },
    });
    const { env, out } = cli(dir);

    expect(await main(["init"], env)).toBe(0);

    expect(out.some((line) => line.startsWith("✓ 1. fill .factory/.env"))).toBe(true);
  });

  it("should still print the list with the defaults when the existing config does not load", async () => {
    const dir = await targetRepo({ name: "toy", files: { "pnpm-lock.yaml": "", ".factory/config.ts": "export default {" } });
    const { env, out, err } = cli(dir);

    expect(await main(["init"], env)).toBe(0);

    expect(err).toEqual([]);
    expect(out.join("\n")).toContain("build the base image and toy-factory-worker:dev");
  });

  it("should leave an existing config with its own roles untouched, so the defaults never overwrite a choice", async () => {
    const config = 'export default { roles: { workers: { agent: "opencode", model: "opencode-go/kimi" } } };\n';
    const dir = await targetRepo({ files: { "pnpm-lock.yaml": "", ".factory/config.ts": config } });
    const { env } = cli(dir);

    expect(await main(["init"], env)).toBe(0);

    expect(await readFile(join(dir, ".factory", "config.ts"), "utf8")).toBe(config);
  });

  it("should print the usage when init gets more than a repo", async () => {
    const { env, err } = cli(await temp.make("init-usage-"));

    expect(await main(["init", "a", "b"], env)).toBe(2);
    expect(err.join("\n")).toContain("factory init [target-repo]");
  });
});
