import { afterEach, describe, expect, it } from "vitest";
import { exec } from "../../src/workers/sh.ts";
import type { AttemptScript } from "../fakes/worker-runner.ts";
import { BRANCH, CONFIG, git, harness, targetRepo, temp, WITH_HUMAN_CRITERION, type Target } from "./harness.ts";

afterEach(() => temp.removeAll());

const EVIDENCE_BRANCH = "factory-evidence/42";

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
    expect(report.log.evidence).toEqual({ branch: EVIDENCE_BRANCH, commit });
    expect(await git(target.remoteDir, "rev-list", "--max-parents=0", EVIDENCE_BRANCH)).toBe(commit);
    expect((await exec("git", ["-C", target.remoteDir, "merge-base", "main", EVIDENCE_BRANCH])).exitCode).toBe(1);
    expect((await exec("git", ["-C", target.remoteDir, "merge-base", BRANCH, EVIDENCE_BRANCH])).exitCode).toBe(1);
    const commands = runner.workers.flatMap((worker) => worker.execs.map((call) => call.command));
    expect(commands.filter((command) => /\bgit\b/.test(command))).toEqual([]);
  });
});
