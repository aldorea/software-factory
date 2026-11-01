import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AttemptScript } from "../fakes/worker-runner.ts";
import { BRANCH, CONFIG, git, harness, targetRepo, temp, WITH_HUMAN_CRITERION, writesHello, type Target } from "./harness.ts";

afterEach(() => temp.removeAll());

async function refusePushesTo(target: Target, refPattern: string): Promise<void> {
  const hook = join(target.remoteDir, "hooks", "pre-receive");
  await writeFile(
    hook,
    `#!/bin/sh\nwhile read old new ref; do\n  case "$ref" in ${refPattern}) echo "push refused" >&2; exit 1;; esac\ndone\n`,
  );
  await chmod(hook, 0o755);
}

describe("a failed push of the integration branch", () => {
  it("should be recorded in run.json with its phase, its message and its time, and the run should keep its result", async () => {
    const target = await targetRepo();
    await refusePushesTo(target, "refs/heads/factory/*");
    const { run, clock } = harness(target, writesHello);

    const report = await run();

    expect(report.result).toBe("ready");
    expect(report.publication).toMatchObject({ kind: "failed", phase: "integration-push" });
    const saved = JSON.parse(await readFile(report.runLogPath, "utf8"));
    expect(saved.result).toBe("ready");
    expect(saved.publicationFailure).toEqual({
      phase: "integration-push",
      message: expect.stringContaining("push refused"),
      at: clock.now().toISOString(),
    });
    expect(saved.pullRequest).toBeUndefined();
    expect(target.github.pullRequests).toEqual([]);
    expect(await git(target.repoDir, "rev-parse", BRANCH)).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("a failed call to the pull request", () => {
  it("should be recorded with the phase of the pull request, after both branches were pushed, and the run should keep its result", async () => {
    const target = await targetRepo();
    target.github.pullRequestFailure = "gh: HTTP 502";
    const { run, notifier } = harness(target, writesHello);

    const report = await run();

    expect(report.result).toBe("ready");
    expect(report.publication).toEqual({ kind: "failed", phase: "pull-request", message: "gh: HTTP 502" });
    expect(report.log.publicationFailure?.phase).toBe("pull-request");
    expect(report.log.pullRequest).toBeUndefined();
    expect(await git(target.remoteDir, "rev-parse", BRANCH)).toBe(await git(target.repoDir, "rev-parse", BRANCH));
    expect(notifier.sent).toEqual([{ title: "factory run #42", message: "Not published: Greeting → factory publish 42" }]);
  });
});

const WITH_EVIDENCE = {
  ...WITH_HUMAN_CRITERION,
  config: CONFIG.replace(
    'evidence: { request: "grep -q hello src/greeting.txt # {{id}}" },',
    'evidence: { request: "grep -q hello src/greeting.txt # {{id}}", playwright: "mkdir -p test-results; cp src/{{id}}.png test-results/", attachments: "test-results" },',
  ),
};

const writesWithPng: AttemptScript = () => ({
  files: { "src/greeting.txt": "hello\n", "src/A2.png": "png-of-the-greeting\n" },
  commit: "Write the greeting",
});

async function failsOnPush(target: Target, refPattern: string, stderrLine: string, times: number): Promise<void> {
  const hook = join(target.remoteDir, "hooks", "pre-receive");
  const counter = join(target.remoteDir, "failures");
  await writeFile(
    hook,
    [
      "#!/bin/sh",
      `failures=$(cat ${counter} 2>/dev/null || echo 0)`,
      "while read old new ref; do",
      `  case "$ref" in ${refPattern})`,
      `    if [ "$failures" -lt ${times} ]; then echo $((failures + 1)) > ${counter}; echo '${stderrLine.replaceAll("'", "'\\''")}' >&2; exit 1; fi;;`,
      "  esac",
      "done",
      "",
    ].join("\n"),
  );
  await chmod(hook, 0o755);
}

const TIMED_OUT = "ssh: connect to host github.com port 22: Operation timed out";

describe("the retries of the publication", () => {
  it("should retry a push of the integration branch that failed on the network, wait 5 and 15 seconds, publish the run and show each retry in the terminal", async () => {
    const target = await targetRepo();
    await failsOnPush(target, "refs/heads/factory/*", TIMED_OUT, 2);
    const { run, waits, progress } = harness(target, writesHello);

    const report = await run();

    expect(report.publication).toMatchObject({ kind: "published" });
    expect(report.log.publicationFailure).toBeUndefined();
    expect(waits).toEqual([5_000, 15_000]);
    expect(await git(target.remoteDir, "rev-parse", BRANCH)).toBe(await git(target.repoDir, "rev-parse", BRANCH));
    expect(progress.filter((line) => line.includes("retry"))).toEqual([
      `publication: retry 1 of 3 in 5s: git push ${BRANCH} failed (1): remote: ${TIMED_OUT}`,
      `publication: retry 2 of 3 in 15s: git push ${BRANCH} failed (1): remote: ${TIMED_OUT}`,
    ]);
  });

  it("should give up after 5, 15 and 45 seconds of waiting and record a failure of the integration push that keeps the message of git", async () => {
    const target = await targetRepo();
    await failsOnPush(target, "refs/heads/factory/*", TIMED_OUT, 99);
    const { run, waits } = harness(target, writesHello);

    const report = await run();

    expect(waits).toEqual([5_000, 15_000, 45_000]);
    expect(report.result).toBe("ready");
    expect(report.publication).toMatchObject({ kind: "failed", phase: "integration-push", message: expect.stringContaining(TIMED_OUT) });
    expect(target.github.pullRequests).toEqual([]);
  });

  it("should not retry a push that failed for another reason, because waiting cannot fix it", async () => {
    const target = await targetRepo();
    await refusePushesTo(target, "refs/heads/factory/*");
    const { run, waits, progress } = harness(target, writesHello);

    const report = await run();

    expect(report.publication).toMatchObject({ kind: "failed", phase: "integration-push" });
    expect(waits).toEqual([]);
    expect(progress.filter((line) => line.includes("retry"))).toEqual([]);
  });

  it("should tell the developer to run gh auth refresh -s workflow when the push is refused for the lack of the workflow scope, and not retry it", async () => {
    const target = await targetRepo();
    await failsOnPush(
      target,
      "refs/heads/factory/*",
      "refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope",
      99,
    );
    const { run, waits } = harness(target, writesHello);

    const report = await run();

    expect(waits).toEqual([]);
    expect(report.publication).toMatchObject({
      kind: "failed",
      phase: "integration-push",
      message: expect.stringContaining("gh auth refresh -s workflow"),
    });
    expect(report.log.publicationFailure?.message).toContain("without `workflow` scope");
  });

  it("should retry a push of the evidence branch that failed on the network and publish the run", async () => {
    const target = await targetRepo(WITH_EVIDENCE);
    await failsOnPush(target, "refs/heads/factory-evidence/*", TIMED_OUT, 1);
    const { run, waits, progress } = harness(target, writesWithPng);

    const report = await run();

    expect(report.publication).toMatchObject({ kind: "published" });
    expect(waits).toEqual([5_000]);
    expect(report.log.evidence?.commit).toBe(await git(target.remoteDir, "rev-parse", "factory-evidence/42"));
    expect(progress.filter((line) => line.includes("retry"))).toEqual([
      `publication: retry 1 of 3 in 5s: git push factory-evidence/42 failed (1): remote: ${TIMED_OUT}`,
    ]);
  });

  it("should retry the call that opens the pull request when it failed on the network and publish the run", async () => {
    const target = await targetRepo();
    target.github.pullRequestFailure = "gh pr create failed (1): error connecting to api.github.com";
    target.github.pullRequestFailures = 2;
    const { run, waits, progress } = harness(target, writesHello);

    const report = await run();

    expect(report.publication).toMatchObject({ kind: "published" });
    expect(waits).toEqual([5_000, 15_000]);
    expect(target.github.pullRequests).toHaveLength(1);
    expect(progress.filter((line) => line.includes("retry"))).toEqual([
      "publication: retry 1 of 3 in 5s: gh pr create failed (1): error connecting to api.github.com",
      "publication: retry 2 of 3 in 15s: gh pr create failed (1): error connecting to api.github.com",
    ]);
  });

  it("should give up on a pull request call that keeps failing on the network, after 5, 15 and 45 seconds", async () => {
    const target = await targetRepo();
    target.github.pullRequestFailure = "gh pr create failed (1): error connecting to api.github.com";
    const { run, waits } = harness(target, writesHello);

    const report = await run();

    expect(waits).toEqual([5_000, 15_000, 45_000]);
    expect(report.publication).toMatchObject({ kind: "failed", phase: "pull-request" });
  });

  it("should show the message of a failed publication in the terminal, because the summary only says that it was not published", async () => {
    const target = await targetRepo();
    await refusePushesTo(target, "refs/heads/factory/*");
    const { run, progress } = harness(target, writesHello);

    await run();

    expect(progress.some((line) => line.startsWith("publication failed at the integration push:") && line.includes("push refused"))).toBe(true);
  });
});
