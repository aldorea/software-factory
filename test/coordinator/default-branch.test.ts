import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AttemptScript, FakeWorkerRecord } from "../fakes/worker-runner.ts";
import { BRANCH, git, harness, targetRepo, temp, writesHello } from "./harness.ts";

afterEach(() => temp.removeAll());

const verifications = (runner: { workers: FakeWorkerRecord[] }) =>
  runner.workers.filter((worker) => /-verification(-\d+)?$/.test(worker.spec.id));

function advancesMain(repoDir: string, file: string, text: string): AttemptScript {
  return async (call) => {
    if (call.number === 1) {
      await mkdir(dirname(join(repoDir, file)), { recursive: true });
      await writeFile(join(repoDir, file), text);
      await git(repoDir, "add", file);
      await git(repoDir, "commit", "-q", "-m", "Move main during the run");
    }
    return writesHello(call);
  };
}

describe("factory run: the default branch moves during the run", () => {
  it("should merge the default branch and verify the result again before the pull request is ready, so the evidence is of the commit to merge", async () => {
    const target = await targetRepo();
    const { run, runner } = harness(target, advancesMain(target.repoDir, "NOTES.md", "notes\n"));

    const report = await run();

    const head = await git(target.repoDir, "rev-parse", BRANCH);
    expect(report.result).toBe("ready");
    expect(await git(target.repoDir, "merge-base", "--is-ancestor", "main", BRANCH).then(() => true)).toBe(true);
    expect(report.log.verification?.sha).toBe(head);
    expect(verifications(runner).map((worker) => /verification(-\d+)?$/.exec(worker.spec.id)?.[0])).toEqual(["verification", "verification-2"]);
    expect(target.github.pullRequests[0]?.draft).toBe(false);
  });

  it("should verify only once when the default branch did not move", async () => {
    const target = await targetRepo();
    const { run, runner } = harness(target, writesHello);

    const report = await run();

    expect(report.result).toBe("ready");
    expect(verifications(runner)).toHaveLength(1);
  });

  it("should block the run and leave the pull request a draft when the default branch conflicts with the integration branch", async () => {
    const target = await targetRepo();
    const { run } = harness(target, advancesMain(target.repoDir, "src/greeting.txt", "good morning\n"));

    const report = await run();

    const head = await git(target.repoDir, "rev-parse", BRANCH);
    expect(report.result).toBe("draft");
    expect(report.log.block).toMatchObject({ type: "default-branch-conflict", sha: head, files: ["src/greeting.txt"] });
    expect(report.log.friction.integrationConflicts).toBe(1);
    expect(await git(target.repoDir, "status", "--porcelain")).toBe("");
    const body = target.github.pullRequests[0]?.body ?? "";
    expect(target.github.pullRequests[0]?.draft).toBe(true);
    expect(body).toContain("Draft: the run is blocked by default-branch-conflict (see Blocks).");
    expect(body).toContain(`**default-branch-conflict** on \`${head.slice(0, 12)}\`: main moved during the run`);
  });
});
