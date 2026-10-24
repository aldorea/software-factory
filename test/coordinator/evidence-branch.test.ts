import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exec } from "../../src/workers/sh.ts";
import type { AttemptScript } from "../fakes/worker-runner.ts";
import { BRANCH, CONFIG, git, harness, targetRepo, temp, WITH_HUMAN_CRITERION, type Target } from "./harness.ts";

afterEach(() => temp.removeAll());

const EVIDENCE_BRANCH = "factory-evidence/42";
const REPOSITORY = "https://github.test/aldorea/greeting";

const WITH_ATTACHMENTS = CONFIG.replace(
  'evidence: { request: "grep -q hello src/greeting.txt # {{id}}" },',
  'evidence: { request: "grep -q hello src/greeting.txt # {{id}}", playwright: "mkdir -p test-results; cp src/{{id}}.png test-results/", attachments: "test-results" },',
);

function writes(png: string): AttemptScript {
  return () => ({ files: { "src/greeting.txt": "hello\n", "src/A2.png": png }, commit: "Write the greeting" });
}

function withAttachments(): Promise<Target> {
  return targetRepo({ ...WITH_HUMAN_CRITERION, config: WITH_ATTACHMENTS });
}

async function remoteFiles(target: Target, ref: string): Promise<string[]> {
  return (await git(target.remoteDir, "ls-tree", "-r", "--name-only", ref)).split("\n");
}

describe("the evidence branch", () => {
  it("should push the attachments of each human criterion to factory-evidence/<n> under a folder per run and criterion", async () => {
    const target = await withAttachments();
    const { run } = harness(target, writes("png-of-the-greeting\n"));

    const report = await run();

    const folder = `${report.log.runId}/A2`;
    expect(await remoteFiles(target, EVIDENCE_BRANCH)).toEqual([`${folder}/A2.png`]);
    expect(await git(target.remoteDir, "show", `${EVIDENCE_BRANCH}:${folder}/A2.png`)).toBe("png-of-the-greeting");
  });

  it("should commit the branch with no common history with main and record the commit in run.json", async () => {
    const target = await withAttachments();
    const { run, runner } = harness(target, writes("png-of-the-greeting\n"));

    const report = await run();

    const commit = await git(target.remoteDir, "rev-parse", EVIDENCE_BRANCH);
    expect(report.log.evidence).toEqual({ branch: EVIDENCE_BRANCH, commit, repositoryUrl: REPOSITORY });
    expect(await git(target.remoteDir, "rev-list", "--max-parents=0", EVIDENCE_BRANCH)).toBe(commit);
    expect((await exec("git", ["-C", target.remoteDir, "merge-base", "main", EVIDENCE_BRANCH])).exitCode).toBe(1);
    expect((await exec("git", ["-C", target.remoteDir, "merge-base", BRANCH, EVIDENCE_BRANCH])).exitCode).toBe(1);
    const commands = runner.workers.flatMap((worker) => worker.execs.map((call) => call.command));
    expect(commands.filter((command) => /\bgit\b/.test(command))).toEqual([]);
  });

  it("should link each human criterion to its files at the pushed commit, render images inline and leave the criterion unchecked", async () => {
    const target = await withAttachments();
    const { run } = harness(target, writes("png-of-the-greeting\n"));

    const report = await run();

    const commit = await git(target.remoteDir, "rev-parse", EVIDENCE_BRANCH);
    const url = `${REPOSITORY}/blob/${commit}/${report.log.runId}/A2/A2.png`;
    const body = target.github.pullRequests[0]?.body ?? "";
    expect(body).toContain(
      [
        `- [ ] A2 The greeting looks friendly. Reason: Looks are subjective. Attachments: [A2.png](${url})`,
        `  ![A2.png](${url}?raw=true)`,
      ].join("\n"),
    );
    expect(body).toContain(`on branch \`${EVIDENCE_BRANCH}\` at \`${commit.slice(0, 12)}\``);
    expect(body).not.toContain("- [x] A2");
    expect(body).not.toContain("/attachments/");
  });

  it("should add a commit on a second run, keep the earlier ones and link the files of the latest run at the new commit", async () => {
    const target = await withAttachments();
    const first = harness(target, writes("png-of-the-first-run\n"));
    const firstReport = await first.run();
    const firstCommit = await git(target.remoteDir, "rev-parse", EVIDENCE_BRANCH);
    const second = harness(target, writes("png-of-the-first-run\n"));
    second.clock.advance(60_000);

    const secondReport = await second.run();

    const secondCommit = await git(target.remoteDir, "rev-parse", EVIDENCE_BRANCH);
    expect(secondReport.log.runId).not.toBe(firstReport.log.runId);
    expect(await git(target.remoteDir, "rev-parse", `${secondCommit}^`)).toBe(firstCommit);
    expect(await remoteFiles(target, EVIDENCE_BRANCH)).toEqual([
      `${firstReport.log.runId}/A2/A2.png`,
      `${secondReport.log.runId}/A2/A2.png`,
    ]);
    expect(await git(target.remoteDir, "show", `${firstCommit}:${firstReport.log.runId}/A2/A2.png`)).toBe("png-of-the-first-run");
    expect(target.github.pullRequests).toHaveLength(1);
    expect(target.github.pullRequests[0]?.body).toContain(`${REPOSITORY}/blob/${secondCommit}/${secondReport.log.runId}/A2/A2.png`);
    expect(target.github.pullRequests[0]?.body).not.toContain(firstCommit);
  });

  it("should continue the branch from the remote when the local branch is gone", async () => {
    const target = await withAttachments();
    const first = harness(target, writes("png-of-the-first-run\n"));
    const firstReport = await first.run();
    const firstCommit = await git(target.remoteDir, "rev-parse", EVIDENCE_BRANCH);
    await git(target.repoDir, "branch", "-D", EVIDENCE_BRANCH);
    const second = harness(target, writes("png-of-the-second-run\n"));
    second.clock.advance(60_000);

    await second.run();

    const secondCommit = await git(target.remoteDir, "rev-parse", EVIDENCE_BRANCH);
    expect(await git(target.remoteDir, "rev-parse", `${secondCommit}^`)).toBe(firstCommit);
    expect(await remoteFiles(target, EVIDENCE_BRANCH)).toContain(`${firstReport.log.runId}/A2/A2.png`);
  });

  it("should neither create nor push the branch when no human criterion has attachments", async () => {
    const withoutAttachments = await targetRepo({ ...WITH_HUMAN_CRITERION });
    const bare = harness(withoutAttachments, writes("png-of-the-greeting\n"));

    const report = await bare.run();

    expect(report.log.verification?.humanCriteria).toEqual([{ id: "A2", reason: "Looks are subjective", attachments: [] }]);
    expect(report.log.evidence).toBeUndefined();
    expect(await git(withoutAttachments.remoteDir, "branch", "--list", EVIDENCE_BRANCH)).toBe("");
    expect(await git(withoutAttachments.repoDir, "branch", "--list", EVIDENCE_BRANCH)).toBe("");
    expect(report.result).toBe("ready");
    expect(withoutAttachments.github.pullRequests[0]?.body).toContain("Attachments: none");
  });
});

describe("a failure to publish the evidence branch", () => {
  async function refusingRemote(): Promise<Target> {
    const target = await withAttachments();
    const hook = join(target.remoteDir, "hooks", "pre-receive");
    await writeFile(
      hook,
      '#!/bin/sh\nwhile read old new ref; do\n  case "$ref" in refs/heads/factory-evidence/*) echo "evidence refused" >&2; exit 1;; esac\ndone\n',
    );
    await chmod(hook, 0o755);
    return target;
  }

  it("should be recorded in run.json, named in the pull request and keep it a draft, without losing the integration branch", async () => {
    const target = await refusingRemote();
    const { run } = harness(target, writes("png-of-the-greeting\n"));

    const report = await run();

    expect(report.result).toBe("draft");
    expect(report.log.evidence?.branch).toBe(EVIDENCE_BRANCH);
    expect(report.log.evidence?.failure).toContain("evidence refused");
    const body = target.github.pullRequests[0]?.body ?? "";
    expect(target.github.pullRequests[0]?.draft).toBe(true);
    expect(body).toContain("Draft: the attachments of the human criteria were not published:");
    expect(body).toContain(`The attachments could not be published to \`${EVIDENCE_BRANCH}\``);
    expect(body).toContain(`.factory/logs/${report.log.runId}/attachments/A2/A2.png`);
    expect(body).not.toContain("/blob/");
    expect(await git(target.remoteDir, "rev-parse", BRANCH)).toBe(await git(target.repoDir, "rev-parse", BRANCH));
    expect(await git(target.remoteDir, "branch", "--list", EVIDENCE_BRANCH)).toBe("");
    const saved = JSON.parse(await readFile(report.runLogPath, "utf8"));
    expect(saved.evidence.failure).toContain("evidence refused");
  });

  it("should add a commit on top of the unpushed one when the next run publishes again", async () => {
    const target = await refusingRemote();
    const first = harness(target, writes("png-of-the-first-run\n"));
    await first.run();
    await rm(join(target.remoteDir, "hooks", "pre-receive"));
    const second = harness(target, writes("png-of-the-second-run\n"));
    second.clock.advance(60_000);

    const report = await second.run();

    expect(report.log.evidence?.failure).toBeUndefined();
    expect(report.result).toBe("ready");
    expect((await git(target.remoteDir, "rev-list", "--count", EVIDENCE_BRANCH))).toBe("2");
  });

  it("should be recorded when the address of the repository cannot be read, with the commit already pushed", async () => {
    const target = await withAttachments();
    target.github.repositoryUrlFailure = "gh is not logged in";
    const { run } = harness(target, writes("png-of-the-greeting\n"));

    const report = await run();

    expect(report.result).toBe("draft");
    expect(report.log.evidence).toMatchObject({ branch: EVIDENCE_BRANCH, failure: "gh is not logged in" });
    expect(target.github.pullRequests[0]?.body).toContain("gh is not logged in");
    expect(await git(target.remoteDir, "branch", "--list", EVIDENCE_BRANCH)).toContain(EVIDENCE_BRANCH);
  });
});
