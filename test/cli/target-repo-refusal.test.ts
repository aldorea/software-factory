import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, type CliEnv } from "../../src/cli/main.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeGitHub } from "../fakes/github.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeVerifier } from "../fakes/verifier.ts";
import { FakeWorkerRunner } from "../fakes/worker-runner.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

function cli(cwd: string, factoryRoot: string) {
  const out: string[] = [];
  const err: string[] = [];
  const launches: unknown[] = [];
  const stop = new AbortController();
  stop.abort();
  const env: CliEnv = {
    cwd,
    factoryRoot,
    clock: new FakeClock("2026-10-24T08:00:00.000Z"),
    github: () => new FakeGitHub([]),
    runner: () => new FakeWorkerRunner(),
    verifier: () => new FakeVerifier(),
    notifier: new FakeNotifier(),
    credentials: {},
    docker: async () => null,
    gh: async () => null,
    launch: async (launch) => {
      launches.push(launch);
      return 0;
    },
    signal: stop.signal,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };
  return { env, out, err, launches };
}

async function tree(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).sort();
}

const COMMANDS: { name: string; args: string[] }[] = [
  { name: "refine", args: ["refine", "12"] },
  { name: "validate", args: ["validate", "12"] },
  { name: "approve", args: ["approve", "12"] },
  { name: "run", args: ["run", "12"] },
  { name: "stats", args: ["stats"] },
  { name: "web", args: ["web"] },
  { name: "init", args: ["init"] },
];

interface Place {
  name: string;
  setup(): Promise<{ cwd: string; factoryRoot: string }>;
}

const PLACES: Place[] = [
  {
    name: "the factory",
    async setup() {
      const factoryRoot = await temp.make("factory-");
      await writeFile(join(factoryRoot, "package.json"), "{}\n");
      return { cwd: factoryRoot, factoryRoot };
    },
  },
  {
    name: "a folder inside .factory/worktrees/",
    async setup() {
      const parent = await temp.make("worktree-");
      const cwd = join(parent, "app", ".factory", "worktrees", "issue-12");
      await mkdir(cwd, { recursive: true });
      return { cwd, factoryRoot: join(parent, "factory") };
    },
  },
];

describe("every command that takes a target repo", () => {
  for (const place of PLACES) {
    for (const command of COMMANDS) {
      it(`should refuse ${command.name} from ${place.name}, name the fix and create nothing`, async () => {
        const { cwd, factoryRoot } = await place.setup();
        const before = await tree(cwd);
        const { env, out, err, launches } = cli(cwd, factoryRoot);

        expect(await main(command.args, env)).toBe(1);

        expect(err.join("\n")).toContain("pass the path of the target repo, or run the command from its root");
        expect(out).toEqual([]);
        expect(launches).toEqual([]);
        expect(await tree(cwd)).toEqual(before);
      });
    }

    it(`should refuse a target repo given as the last argument that is ${place.name}`, async () => {
      const { cwd, factoryRoot } = await place.setup();
      const other = await temp.make("elsewhere-");
      const { env, err } = cli(other, factoryRoot);

      expect(await main(["run", "12", cwd], env)).toBe(1);
      expect(await main(["stats", cwd], env)).toBe(1);
      expect(err).toHaveLength(2);
    });
  }

  it("should not refuse a regular target repo", async () => {
    const parent = await temp.make("regular-");
    const repo = join(parent, "app");
    await mkdir(repo);
    const { env, err } = cli(repo, join(parent, "factory"));

    expect(await main(["stats"], env)).toBe(0);
    expect(err).toEqual([]);
  });
});
