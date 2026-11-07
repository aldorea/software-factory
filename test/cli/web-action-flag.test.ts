import { existsSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, type CliEnv } from "../../src/cli/main.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeGitHub } from "../fakes/github.ts";
import { FakeImageDocker } from "../fakes/image-docker.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeVerifier } from "../fakes/verifier.ts";
import { FakeWorkerRunner } from "../fakes/worker-runner.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

const ID = "2026-11-07T10-42-00-000Z-validate-28";

function cli(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const env: CliEnv = {
    cwd,
    factoryRoot: "/factory",
    clock: new FakeClock("2026-11-07T10:43:00.000Z"),
    github: () => new FakeGitHub([]),
    runner: () => new FakeWorkerRunner(),
    verifier: () => new FakeVerifier(),
    notifier: new FakeNotifier(),
    credentials: {},
    docker: async () => null,
    gh: async () => null,
    claudeSession: async () => null,
    originHead: async () => null,
    push: async () => null,
    launch: async () => 0,
    images: new FakeImageDocker(),
    signal: new AbortController().signal,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };
  return { env, out, err };
}

describe("the --web-action flag of the CLI", () => {
  it("should record the exit code and the end time in the folder of the web action when the command ends", async () => {
    const dir = await temp.make("web-action-flag-");
    await mkdir(join(dir, ".factory", "web", ID), { recursive: true });
    const { env } = cli(dir);

    const code = await main(["validate", "28", "--web-action", ID], env);

    expect(code).toBe(1);
    expect(JSON.parse(await readFile(join(dir, ".factory", "web", ID, "end.json"), "utf8"))).toEqual({
      exitCode: 1,
      endedAt: "2026-11-07T10:43:00.000Z",
    });
  });

  it("should run the command as without the flag, so every rule of the CLI holds unchanged", async () => {
    const dir = await temp.make("web-action-flag-");
    await mkdir(join(dir, ".factory", "web", ID), { recursive: true });
    const flagged = cli(dir);
    const plain = cli(dir);

    await main(["validate", "28", "--web-action", ID], flagged.env);
    await main(["validate", "28"], plain.env);

    expect(flagged.err).toEqual(plain.err);
  });

  it("should write nothing when the folder of the web action does not exist, so a command started by hand creates no web state", async () => {
    const dir = await temp.make("web-action-flag-");
    const { env } = cli(dir);

    await main(["validate", "28", "--web-action", ID], env);

    expect(existsSync(join(dir, ".factory", "web"))).toBe(false);
  });

  it("should refuse an ID that is not one segment, so the end is never written outside .factory/web/", async () => {
    const dir = await temp.make("web-action-flag-");
    await mkdir(join(dir, ".factory", "web"), { recursive: true });
    const { env, err } = cli(dir);

    expect(await main(["validate", "28", "--web-action", "../../escape"], env)).toBe(2);

    expect(err.join("\n")).toContain("usage: factory");
    expect(await readdir(join(dir, ".factory", "web"))).toEqual([]);
  });
});
