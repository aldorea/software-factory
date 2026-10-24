import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, type CliEnv } from "../../src/cli/main.ts";
import { writeRunLog, type RunLog } from "../../src/coordinator/run-log.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeGitHub } from "../fakes/github.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeVerifier } from "../fakes/verifier.ts";
import { FakeWorkerRunner } from "../fakes/worker-runner.ts";
import { tempDirs } from "../temp-dirs.ts";
import { cleanRun, failedRun, pausedRun } from "../coordinator/run-log-fixtures.ts";

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
    launch: async () => 0,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };
  return { env, out, err };
}

async function repoWithRuns(runs: RunLog[]): Promise<string> {
  const dir = await temp.make("stats-repo-");
  for (const run of runs) await writeRunLog(join(dir, ".factory", "logs", run.runId, "run.json"), run);
  return dir;
}

describe("factory stats", () => {
  it("should print the summary of the runs of the current directory and exit zero", async () => {
    const dir = await repoWithRuns([cleanRun(0), failedRun(1), pausedRun(2)]);
    const { env, out } = cli(dir);

    expect(await main(["stats"], env)).toBe(0);
    expect(out.join("\n")).toContain("Runs: 3 (ready 2, draft 0, paused 1)");
    expect(out.join("\n")).toContain("Worker-layer failures: container-start 1");
  });

  it("should take the target repo from the argument", async () => {
    const dir = await repoWithRuns([cleanRun(0)]);
    const { env, out } = cli(await temp.make("stats-elsewhere-"));

    expect(await main(["stats", dir], env)).toBe(0);
    expect(out.join("\n")).toContain("Runs: 1 (ready 1, draft 0, paused 0)");
  });

  it("should say clearly that a repo with no runs has none and still exit zero", async () => {
    const dir = await temp.make("stats-empty-");
    const { env, out, err } = cli(dir);

    expect(await main(["stats"], env)).toBe(0);
    expect(out.join("\n")).toBe("No runs yet: .factory/logs has no run.json files.");
    expect(err).toEqual([]);
  });

  it("should list the run.json files it could not read", async () => {
    const dir = await repoWithRuns([cleanRun(0)]);
    await writeRunLog(join(dir, ".factory", "logs", "9-old", "run.json"), { ...cleanRun(1), version: 0 as 1 });
    const { env, out } = cli(dir);

    expect(await main(["stats"], env)).toBe(0);
    expect(out.join("\n")).toContain("Unreadable run.json files: 9-old/run.json");
  });

  it("should print the usage when stats gets more than a repo", async () => {
    const { env, err } = cli(await temp.make("stats-usage-"));

    expect(await main(["stats", "a", "b"], env)).toBe(2);
    expect(err.join("\n")).toContain("factory stats [target-repo]");
  });
});
