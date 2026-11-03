import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { logPathsOf } from "../../src/coordinator/run-log-paths.ts";
import type { RunLog } from "../../src/coordinator/run-log.ts";
import type { WorkerSpec } from "../../src/workers/types.ts";
import { passingTester, type AttemptScript, type TesterScript } from "../fakes/worker-runner.ts";
import { CONFIG, harness, specText, targetRepo, temp, writesHello, type Target } from "./harness.ts";

afterEach(() => temp.removeAll());

const SECOND_CHECK = "test -n second";

const GREETING = "grep -q hello src/greeting.txt";

const TWO_CHECKS = CONFIG.replace(
  'checks: [{ name: "greeting", command: "grep -q hello src/greeting.txt" }],',
  `checks: [{ name: "greeting", command: "grep -q hello src/greeting.txt" }, { name: "second", command: ${JSON.stringify(SECOND_CHECK)} }],`,
);

const INTEGRATION_CRITERION = specText({
  files: { A1: ["src/greeting.txt"] },
  base: null,
  subtasks: [{ id: "S1", criteria: ["A1"], scope: ["src/", "ok-A1"], dependsOn: [], testChanges: [] }],
  criteria: { A1: { evidence: "request", level: "integration" } },
});

const CRITERION_LATE = TWO_CHECKS.replace(
  'evidence: { request: "grep -q hello src/greeting.txt # {{id}}" },',
  'evidence: { request: "test -e ok-{{id}}" },',
);

const criterionInFollowUp: AttemptScript = (call) =>
  call.spec.id.includes("followup")
    ? { files: { "ok-A1": "ok\n" }, commit: "Fix the criterion" }
    : { files: { "src/greeting.txt": "hello\n" }, commit: "Write the greeting" };

const DEPS = ".factory/logs/deps";
const INSTALL = `mkdir -p ${DEPS}`;
const START = `test -d ${DEPS} && touch ${DEPS}/up`;
const READY = `test -f ${DEPS}/up`;
const WITH_APP = CONFIG.replace(
  'checks: [{ name: "greeting", command: "grep -q hello src/greeting.txt" }],',
  `checks: [{ name: "install", command: ${JSON.stringify(INSTALL)} }, { name: "greeting", command: "grep -q hello src/greeting.txt" }],
app: { start: ${JSON.stringify(START)}, ready: ${JSON.stringify(READY)}, readyTimeoutMs: 600000 },`,
);

async function currentRunLog(target: Target): Promise<RunLog> {
  const logsDir = join(target.repoDir, ".factory", "logs");
  const [runId] = (await readdir(logsDir)).filter((entry) => !entry.includes("."));
  return JSON.parse(await readFile(join(logsDir, runId ?? "", "run.json"), "utf8")) as RunLog;
}

const inVerification = (spec: WorkerSpec) => /-verification(-\d+)?$/.test(spec.id);

describe("factory run: the progress of the integrated verification in run.json", () => {
  it("should record each check of the integrated verification as soon as it ends, so the web shows the step that runs", async () => {
    const target = await targetRepo({ config: TWO_CHECKS });
    const seen: RunLog[] = [];
    const { run } = harness(target, writesHello, {}, undefined, async (spec, command) => {
      if (inVerification(spec) && command === SECOND_CHECK) seen.push(await currentRunLog(target));
    });

    const report = await run();

    const [before] = seen;
    expect(before?.verificationProgress?.checks).toEqual([expect.objectContaining({ name: "greeting", passed: true, exitCode: 0 })]);
    expect(before?.verificationProgress?.criteria).toEqual([]);
    expect(report.log.verificationProgress).toBeUndefined();
    expect(report.log.verification?.checks.map((check) => check.name)).toEqual(["greeting", "second"]);
  });

  it("should record the step of the integrated verification that runs now: a check, the start of the app or a criterion", async () => {
    const target = await targetRepo({ config: WITH_APP });
    const steps: Array<[string, unknown]> = [];
    const { run } = harness(target, writesHello, {}, undefined, async (spec, command) => {
      if (!inVerification(spec)) return;
      const step =
        command === INSTALL ? "install" : command === GREETING ? "greeting" : command.includes(START) ? "start" : command === `${GREETING} # A1` ? "A1" : null;
      if (step !== null) steps.push([step, (await currentRunLog(target)).verificationProgress?.current]);
    });

    const report = await run();

    expect(steps).toEqual([
      ["install", { kind: "check", name: "install" }],
      ["greeting", { kind: "check", name: "greeting" }],
      ["start", { kind: "app" }],
      ["A1", { kind: "criterion", id: "A1" }],
    ]);
    expect(report.result).toBe("ready");
  });

  it("should start a second round of verification with empty progress and without the record of the first round", async () => {
    const target = await targetRepo({ config: CRITERION_LATE, spec: INTEGRATION_CRITERION });
    const seen: RunLog[] = [];
    const { run } = harness(target, criterionInFollowUp, {}, undefined, async (spec, command) => {
      if (spec.id.endsWith("-verification-2") && command === SECOND_CHECK) seen.push(await currentRunLog(target));
    });

    const report = await run();

    const [second] = seen;
    expect(second?.verification).toBeUndefined();
    expect(second?.verificationProgress?.checks.map((check) => check.name)).toEqual(["greeting"]);
    expect(second?.verificationProgress?.criteria).toEqual([]);
    expect(second?.verificationProgress?.sha).toBe(report.log.verification?.sha);
    expect(report.result).toBe("ready");
  });

  it("should list the output of a check that failed in the round in progress among the paths of the run, so the web can link it before the round ends", async () => {
    const failsInVerification = 'case "$PWD" in *-verification) echo "the greeting is gone" >&2; exit 1;; esac; grep -q hello src/greeting.txt';
    const target = await targetRepo({ config: TWO_CHECKS.replace('"grep -q hello src/greeting.txt" }, { name: "second"', `${JSON.stringify(failsInVerification)} }, { name: "second"`) });
    const seen: RunLog[] = [];
    const { run } = harness(target, writesHello, {}, undefined, async (spec, command) => {
      if (inVerification(spec) && command === SECOND_CHECK) seen.push(await currentRunLog(target));
    });

    await run();

    const [before] = seen;
    expect(before?.verificationProgress?.checks).toEqual([expect.objectContaining({ name: "greeting", passed: false, outputLog: "output/verification/check-1-greeting.log" })]);
    expect(logPathsOf(before as RunLog)).toContain("output/verification/check-1-greeting.log");
  });
});

describe("factory run: the phase of the acceptance tester in run.json", () => {
  it("should record the phase of the tester while it installs, starts the app, waits for it and tests the criteria, and replace the phase with its record when it ends", async () => {
    const target = await targetRepo({ config: WITH_APP });
    const phases: Array<[string, string | undefined]> = [];
    const tester: TesterScript = async (call) => {
      phases.push(["attempt", (await currentRunLog(target)).verification?.testerPhase]);
      return passingTester(call);
    };
    const { run } = harness(target, writesHello, {}, tester, async (spec, command) => {
      if (!spec.id.endsWith("-verification-tester")) return;
      const step = command === INSTALL ? "install" : command.includes(START) ? "start" : command === READY ? "ready" : null;
      if (step !== null) phases.push([step, (await currentRunLog(target)).verification?.testerPhase]);
    });

    const report = await run();

    expect(phases).toEqual([
      ["install", "install"],
      ["start", "start"],
      ["ready", "ready"],
      ["attempt", "testing"],
    ]);
    expect(report.log.verification?.testerPhase).toBeUndefined();
    expect(report.log.verification?.tester?.verdicts).toEqual([expect.objectContaining({ id: "A1", passed: true })]);
  });
});
