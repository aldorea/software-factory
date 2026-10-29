import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../../src/config/config.ts";
import { runIssue } from "../../src/coordinator/run.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeVerifier } from "../fakes/verifier.ts";
import { FakeWorkerRunner, type AttemptScript } from "../fakes/worker-runner.ts";
import { CONFIG, harness, ISSUE, targetRepo, temp, TOKEN, writesHello, type Target } from "./harness.ts";

afterEach(() => temp.removeAll());

const limited: AttemptScript = () => ({ outcome: { kind: "plan-limit", message: "5-hour limit reached" } });

function configWithLimit(attemptIdleTimeoutMs: number): string {
  return CONFIG.replace("  roles:", `  limits: { attemptIdleTimeoutMs: ${attemptIdleTimeoutMs} },\n  roles:`);
}

function runAt(target: Target, script: AttemptScript, at: string) {
  return runIssue(
    { repoDir: target.repoDir, issue: ISSUE, credentials: { "claude-code": TOKEN, opencode: "key-of-the-host" } },
    {
      runner: new FakeWorkerRunner(script),
      verifier: new FakeVerifier(),
      github: target.github,
      notifier: new FakeNotifier(),
      clock: new FakeClock(at),
    },
  );
}

describe("factory run recording the idle threshold in run.json", () => {
  it("should write the attemptIdleTimeoutMs of the config of the repo when the run starts", async () => {
    const target = await targetRepo({ config: configWithLimit(1_800_000) });

    const report = await harness(target, writesHello).run();

    expect(report.log.attemptIdleTimeoutMs).toBe(1_800_000);
  });

  it("should write the default attemptIdleTimeoutMs when the config does not set it", async () => {
    const target = await targetRepo();

    const report = await harness(target, writesHello).run();

    expect(report.log.attemptIdleTimeoutMs).toBe(DEFAULT_LIMITS.run.attemptIdleTimeoutMs);
  });

  it("should keep the recorded attemptIdleTimeoutMs when a paused run resumes after the config changed", async () => {
    const target = await targetRepo({ config: configWithLimit(1_800_000) });
    const paused = await runAt(target, limited, "2026-10-24T08:00:00.000Z");
    expect(paused.result).toBe("paused");
    expect(paused.log.attemptIdleTimeoutMs).toBe(1_800_000);
    await writeFile(join(target.repoDir, ".factory", "config.ts"), configWithLimit(60_000));

    const resumed = await runAt(target, writesHello, "2026-10-24T13:30:00.000Z");

    expect(resumed.result).toBe("ready");
    expect(resumed.log.attemptIdleTimeoutMs).toBe(1_800_000);
  });
});
