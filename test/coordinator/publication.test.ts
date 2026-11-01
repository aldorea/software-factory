import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BRANCH, git, harness, targetRepo, temp, writesHello, type Target } from "./harness.ts";

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
