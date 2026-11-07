import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clockMinutes } from "../../src/cli/clock-time.ts";
import { main, type CliEnv } from "../../src/cli/main.ts";
import { writeRunningRun } from "../coordinator/running-run.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeGitHub } from "../fakes/github.ts";
import { FakeImageDocker } from "../fakes/image-docker.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeVerifier } from "../fakes/verifier.ts";
import { FakeWorkerRunner } from "../fakes/worker-runner.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

const NOW = "2026-10-24T08:00:00.000Z";

function cli(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const env: CliEnv = {
    cwd,
    factoryRoot: "/factory",
    clock: new FakeClock(NOW),
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

async function repoWithRunningRun(startedAt: string): Promise<{ dir: string; runId: string }> {
  const dir = await temp.make("one-run-");
  const at = new Date(startedAt);
  const run = await writeRunningRun({ logsDir: join(dir, ".factory", "logs"), issue: 28, runJsonAt: at, logAt: at });
  return { dir, runId: run.runId };
}

describe("one run at a time per issue", () => {
  it.each(["run", "approve"])(
    "should refuse factory %s while the last run of the issue is running, saying since when and when it counts as abandoned",
    async (command) => {
      const { dir, runId } = await repoWithRunningRun("2026-10-24T07:58:00.000Z");
      const { env, err } = cli(dir);

      expect(await main([command, "28"], env)).toBe(1);

      const since = clockMinutes(new Date("2026-10-24T07:58:00.000Z"));
      const until = clockMinutes(new Date("2026-10-24T08:08:00.000Z"));
      expect(err).toEqual([`factory: run ${runId} of #28 is in progress since ${since}; it counts as abandoned at ${until}`]);
    },
  );

  it("should not refuse factory run when the running run is abandoned, because its process is gone", async () => {
    const { dir } = await repoWithRunningRun("2026-10-24T06:00:00.000Z");
    const { env, err } = cli(dir);

    await main(["run", "28"], env);

    expect(err.join("\n")).not.toContain("is in progress since");
  });

  it("should not refuse a run of another issue", async () => {
    const { dir } = await repoWithRunningRun("2026-10-24T07:58:00.000Z");
    const { env, err } = cli(dir);

    await main(["run", "29"], env);

    expect(err.join("\n")).not.toContain("is in progress since");
  });
});
