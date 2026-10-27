import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunLog } from "../../src/coordinator/run-log.ts";
import { subtaskBranch } from "../../src/coordinator/run.ts";
import type { AttemptScript, FakeWorkerRecord } from "../fakes/worker-runner.ts";
import { BRANCH, git, harness, ISSUE, specText, targetRepo, temp } from "./harness.ts";

afterEach(() => temp.removeAll());

const ISSUE_BODY = [
  "## What to build",
  "",
  "Two parts.",
  "",
  "## Acceptance criteria",
  "",
  "- [ ] A1 The first part works.",
  "- [ ] A2 The second part works with the first.",
  "",
].join("\n");

const SPEC = specText({
  files: { A1: ["a/"], A2: ["b/"] },
  base: null,
  subtasks: [
    { id: "S1", criteria: ["A1"], scope: ["a/", "ok-A1"], dependsOn: [], testChanges: [] },
    { id: "S2", criteria: ["A2"], scope: ["b/", "ok-A2"], dependsOn: [], testChanges: [] },
  ],
  criteria: { A1: { evidence: "request", level: "subtask" }, A2: { evidence: "request", level: "integration" } },
});

interface Check {
  name: string;
  command: string;
}

const NO_BAD: Check = { name: "no-bad", command: "test ! -e b/bad.txt" };

function configText(extra = "", checks: Check[] = [NO_BAD], request = "test -e ok-{{id}}"): string {
  return `
export default {
  image: "greeting-worker:dev",
  checks: ${JSON.stringify(checks)},
  evidence: { request: ${JSON.stringify(request)} },
  environment: () => ({}),
  protectedPaths: ["package.json"],
  roles: {
    workers: { agent: "claude-code", model: "sonnet" },
    verifier: { agent: "opencode", model: "opencode-go/kimi-k2" },
  },
  ${extra}
};
`;
}

function target(extra = "", checks?: Check[], request?: string) {
  return targetRepo({ config: configText(extra, checks, request), issueBody: ISSUE_BODY, spec: SPEC });
}

const TALKATIVE_REQUEST = `test -e ok-{{id}} || { echo "noise of {{id}}"; echo "ok-{{id}} is missing" >&2; exit 1; }`;

const subtaskOf = (call: { spec: { id: string } }) => call.spec.id.replace(`${ISSUE}-`, "");

const firstPass: AttemptScript = (call) => {
  const id = subtaskOf(call);
  if (id === "S1") return { files: { "a/a.txt": "a\n", "ok-A1": "ok\n" }, commit: "Part one" };
  return { files: { "b/b.txt": "b\n" }, commit: "Part two" };
};

const fixesSecondCriterion: AttemptScript = (call) =>
  call.spec.id.includes("followup") ? { files: { "ok-A2": "ok\n" }, commit: "Fix the second criterion" } : firstPass(call);

const verifications = (runner: { workers: FakeWorkerRecord[] }) =>
  runner.workers.filter((worker) => /-verification(-\d+)?$/.test(worker.spec.id));

const followUps = (runner: { workers: FakeWorkerRecord[] }) =>
  runner.workers.filter((worker) => /-followup-\d+$/.test(worker.spec.id));

function subtask(log: RunLog, id: string) {
  return log.subtasks.find((entry) => entry.id === id);
}

describe("factory run: follow-up tasks", () => {
  it("should send a follow-up to the subtask that owns the criterion that failed the integrated verification, with the failure in its prompt", async () => {
    const repo = await target();
    const { run, runner } = harness(repo, fixesSecondCriterion);

    const report = await run();

    const [followUp] = followUps(runner);
    expect(followUps(runner)).toHaveLength(1);
    expect(followUp?.spec.id).toBe(`${ISSUE}-S2-followup-1`);
    expect(followUp?.spec.branch).toBe(subtaskBranch(BRANCH, "S2"));
    expect(followUp?.spec.baseRef).toBe(BRANCH);
    const prompt = followUp?.attempts[0]?.prompt ?? "";
    expect(prompt).toContain("criterion A2 (request) failed with exit code 1");
    expect(prompt).toContain("The second part works with the first");
    expect(prompt).toContain("test -e ok-A2");
    expect(report.result).toBe("ready");
  });

  it("should give the follow-up the last lines of the output of the criterion that failed, because the worker may not reproduce the failure", async () => {
    const repo = await target("", [NO_BAD], TALKATIVE_REQUEST);
    const { run, runner } = harness(repo, fixesSecondCriterion);

    await run();

    const prompt = followUps(runner)[0]?.attempts[0]?.prompt ?? "";
    expect(prompt).toContain("The last lines of the output of criterion A2:");
    expect(prompt).toContain("noise of A2\nok-A2 is missing");
  });

  it("should keep the last lines of a failed criterion in run.json and its whole output in the run log", async () => {
    const repo = await target("", [NO_BAD], TALKATIVE_REQUEST);
    const { run } = harness(repo, firstPass);

    const report = await run();

    const failed = report.log.verification?.criteria.find((criterion) => criterion.id === "A2");
    expect(failed?.passed).toBe(false);
    expect(failed?.outputTail).toBe("noise of A2\nok-A2 is missing");
    expect(failed?.outputLog).toMatch(/^output\/.+\/A2\.log$/);
    const whole = await readFile(join(dirname(report.runLogPath), failed?.outputLog ?? ""), "utf8");
    expect(whole).toBe("noise of A2\nok-A2 is missing\n");
    expect(report.log.verification?.criteria.find((criterion) => criterion.id === "A1")?.outputTail).toBeUndefined();
  });

  it("should give the attempt after a gate rejection the last lines of the output of the check that failed", async () => {
    const talkative: Check = { name: "no-bad", command: `! grep -q bad b/b.txt || { echo "b/b.txt says bad"; exit 1; }` };
    const repo = await target("", [talkative]);
    const { run, runner } = harness(repo, (call) =>
      subtaskOf(call) === "S2" && call.number === 1 ? { files: { "b/b.txt": "bad\n" } } : fixesSecondCriterion(call),
    );

    const report = await run();

    const second = runner.workers.find((worker) => worker.spec.id === `${ISSUE}-S2`)?.attempts[1]?.prompt ?? "";
    expect(second).toContain("check no-bad failed with exit code 1");
    expect(second).toContain("The last lines of the output of check no-bad:");
    expect(second).toContain("b/b.txt says bad");
    const rejected = subtask(report.log, "S2")?.attempts[0]?.failure;
    expect(rejected?.output).toContain("b/b.txt says bad");
    expect(rejected?.description).not.toContain("The last lines of the output");
  });

  it("should start the follow-up from the current integration branch, which holds the work of the other subtasks", async () => {
    const repo = await target();
    const seen: { branchTip: string; integrationTip: string; files: string }[] = [];
    const { run } = harness(repo, async (call) => {
      if (call.spec.id.includes("followup")) {
        seen.push({
          branchTip: await git(repo.repoDir, "rev-parse", call.spec.branch),
          integrationTip: await git(repo.repoDir, "rev-parse", BRANCH),
          files: await git(repo.repoDir, "ls-tree", "-r", "--name-only", call.spec.branch),
        });
      }
      return fixesSecondCriterion(call);
    });

    await run();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.branchTip).toBe(seen[0]?.integrationTip);
    expect(seen[0]?.files).toContain("a/a.txt");
  });

  it("should run the integrated verification again after the follow-up merges, and take the evidence from the head of the integration branch", async () => {
    const repo = await target();
    const { run, runner } = harness(repo, fixesSecondCriterion);

    const report = await run();

    expect(verifications(runner)).toHaveLength(2);
    const head = await git(repo.repoDir, "rev-parse", BRANCH);
    expect(report.log.verification?.sha).toBe(head);
    expect(report.log.verification?.passed).toBe(true);
    expect(await git(repo.repoDir, "log", "-1", "--format=%B", BRANCH)).toContain("Factory-Subtask: S2");
    const body = repo.github.pullRequests[0]?.body ?? "";
    expect(body).toContain(`## Integrated verification on \`${head.slice(0, 12)}\``);
    expect(body).toContain(`## Criteria on \`${head.slice(0, 12)}\``);
    expect(body).toContain("- [x] A2 The second part works with the first");
    expect(repo.github.pullRequests[0]?.draft).toBe(false);
  });

  it("should record the follow-up in run.json with its criteria and keep its attempts in the subtask", async () => {
    const repo = await target();
    const { run } = harness(repo, fixesSecondCriterion);

    const { log } = await run();

    expect(subtask(log, "S2")?.followUps).toEqual([
      expect.objectContaining({ round: 1, criteria: ["A2"], outcome: "merged" }),
    ]);
    expect(subtask(log, "S2")?.attempts.map((attempt) => attempt.number)).toEqual([1, 2]);
    expect(subtask(log, "S1")?.followUps ?? []).toEqual([]);
    expect(repo.github.pullRequests[0]?.body).toContain("- **S2** (A2): merged\n  Follow-up 1 (A2): merged");
  });

  it("should send no follow-up when the integrated verification passes", async () => {
    const repo = await target();
    const { run, runner } = harness(repo, (call) =>
      subtaskOf(call) === "S2"
        ? { files: { "b/b.txt": "b\n", "ok-A2": "ok\n" } }
        : firstPass(call),
    );

    const report = await run();

    expect(followUps(runner)).toHaveLength(0);
    expect(verifications(runner)).toHaveLength(1);
    expect(report.result).toBe("ready");
  });

  it("should send no follow-up when only a check of the repo fails, because no subtask owns a check", async () => {
    const repo = await target("", [
      NO_BAD,
      {
        name: "integrated",
        command: `git rev-parse --abbrev-ref HEAD | grep -qv verification || { echo "fails only once integrated"; exit 1; }`,
      },
    ]);
    const { run, runner } = harness(repo, (call) =>
      subtaskOf(call) === "S2" ? { files: { "b/b.txt": "b\n", "ok-A2": "ok\n" } } : firstPass(call),
    );

    const report = await run();

    expect(followUps(runner)).toHaveLength(0);
    expect(verifications(runner)).toHaveLength(1);
    expect(report.log.verification?.passed).toBe(false);
    expect(report.result).toBe("draft");
  });

  it("should record an integration-check block with the check, the SHA and the end of its output when only a check fails, in run.json and in the PR", async () => {
    const repo = await target("", [
      NO_BAD,
      {
        name: "integrated",
        command: `git rev-parse --abbrev-ref HEAD | grep -qv verification || { echo "fails only once integrated"; exit 1; }`,
      },
    ]);
    const { run } = harness(repo, (call) => (subtaskOf(call) === "S2" ? { files: { "b/b.txt": "b\n", "ok-A2": "ok\n" } } : firstPass(call)));

    const report = await run();

    const sha = await git(repo.repoDir, "rev-parse", BRANCH);
    expect(report.log.block?.type).toBe("integration-check");
    expect(report.log.block?.sha).toBe(sha);
    expect(report.log.block).toMatchObject({ checks: [{ name: "integrated", outputTail: "fails only once integrated" }] });
    expect(report.log.block?.type === "integration-check" ? report.log.block.checks : []).toHaveLength(1);
    expect(report.log.friction.blocks["integration-check"]).toBe(1);
    expect(report.log.subtasks.every((entry) => entry.state === "merged")).toBe(true);
    const body = repo.github.pullRequests[0]?.body ?? "";
    expect(body).toContain(`## Blocks\n\n**integration-check** on \`${sha.slice(0, 12)}\`: The check integrated failed on the integration branch`);
    expect(body).toContain("fails only once integrated");
    expect(body).toContain("the run is blocked by integration-check (see Blocks)");
  });

  it("should record no integration-check block when a criterion fails too, because its follow-up carries the failed checks", async () => {
    const repo = await target("", [NO_BAD, { name: "integrated", command: "git rev-parse --abbrev-ref HEAD | grep -qv verification" }]);
    const { run, runner } = harness(repo, firstPass);

    const report = await run();

    expect(followUps(runner).length).toBeGreaterThan(0);
    expect(followUps(runner)[0]?.attempts[0]?.prompt).toContain("These checks of the repo failed in the same run:");
    expect(report.log.block).toBeUndefined();
  });

  it("should block the subtask and leave the pull request a draft when the follow-up hits patience at its gate", async () => {
    const repo = await target();
    const { run, runner } = harness(repo, (call) =>
      call.spec.id.includes("followup") ? { files: { "b/bad.txt": "bad\n" } } : firstPass(call),
    );

    const report = await run();

    const head = await git(repo.repoDir, "rev-parse", BRANCH);
    expect(followUps(runner)[0]?.attempts).toHaveLength(3);
    expect(subtask(report.log, "S2")).toMatchObject({ state: "blocked", blockType: "patience" });
    expect(subtask(report.log, "S2")?.followUps).toEqual([expect.objectContaining({ outcome: "blocked" })]);
    expect(report.result).toBe("draft");
    expect(repo.github.pullRequests[0]?.draft).toBe(true);
    expect(verifications(runner)).toHaveLength(1);
    expect(report.log.verification?.sha).toBe(head);
    expect(repo.github.pullRequests[0]?.body).toContain("**S2** (A2): blocked.");
  });

  it("should block the subtask by patience when its follow-ups keep merging while the same criterion keeps failing", async () => {
    const repo = await target();
    const { run, runner } = harness(repo, (call) =>
      call.spec.id.includes("followup")
        ? { files: { [`b/try-${call.spec.id}.txt`]: "again\n" } }
        : firstPass(call),
    );

    const report = await run();

    expect(followUps(runner)).toHaveLength(2);
    expect(verifications(runner)).toHaveLength(3);
    expect(subtask(report.log, "S2")).toMatchObject({ state: "blocked", blockType: "patience" });
    expect(subtask(report.log, "S2")?.reason).toContain("criterion:A2");
    expect(report.result).toBe("draft");
    expect(report.log.verification?.sha).toBe(await git(repo.repoDir, "rev-parse", BRANCH));
  });

  it("should block the subtask by the run limit when the follow-up cannot start within it", async () => {
    const repo = await target('agents: { "claude-code": { tokensPerRun: 1000 } }');
    const { run } = harness(repo, (call) =>
      call.spec.id.includes("followup") ? { files: { "ok-A2": "ok\n" } } : { ...firstPass(call), usage: { outputTokens: 600 } },
    );

    const report = await run();

    expect(subtask(report.log, "S2")).toMatchObject({ state: "blocked", blockType: "limit" });
    expect(subtask(report.log, "S2")?.block?.type).toBe("run-tokens");
    expect(report.result).toBe("draft");
    expect(repo.github.pullRequests[0]?.draft).toBe(true);
  });

  it("should start no follow-up once the run is past its wall clock, and block the owner by that limit", async () => {
    const repo = await target("limits: { runWallClockMs: 60 * 60 * 1000 }");
    const { run, runner, clock } = harness(repo, (call) => {
      if (subtaskOf(call) === "S2") clock.advance(2 * 60 * 60 * 1000);
      return fixesSecondCriterion(call);
    });

    const report = await run();

    expect(followUps(runner)).toHaveLength(0);
    expect(subtask(report.log, "S2")).toMatchObject({ state: "blocked", blockType: "limit", block: { type: "run-wall-clock" } });
    expect(report.result).toBe("draft");
  });

  it("should give the follow-up the same gate as any attempt and reject a change outside the scope of its subtask", async () => {
    const repo = await target();
    const { run } = harness(repo, (call) =>
      call.spec.id.includes("followup") && call.number === 1
        ? { files: { "a/a.txt": "changed\n", "ok-A2": "ok\n" } }
        : call.spec.id.includes("followup")
          ? { files: { "a/a.txt": "a\n", "ok-A2": "ok\n" } }
          : firstPass(call),
    );

    const report = await run();

    const [followUp] = subtask(report.log, "S2")?.followUps ?? [];
    expect(followUp?.outcome).toBe("merged");
    expect(subtask(report.log, "S2")?.gateRejections).toBe(1);
    expect(subtask(report.log, "S2")?.attempts[1]?.failure?.description).toContain("it touches paths outside its scope");
    expect(await git(repo.repoDir, "show", `${BRANCH}:a/a.txt`)).toBe("a");
    expect(report.result).toBe("ready");
  });

  it("should keep counting the tokens of the subtask across its follow-ups, because a follow-up is more work on the same subtask", async () => {
    const repo = await target('agents: { "claude-code": { tokensPerSubtask: 1000 } }');
    const usage = { outputTokens: 800 };
    const { run, runner } = harness(repo, (call) => {
      if (call.spec.id.includes("followup")) {
        return call.number === 1
          ? { files: { "a/a.txt": "changed\n" }, usage }
          : { files: { "a/a.txt": "a\n", "ok-A2": "ok\n" }, usage };
      }
      return subtaskOf(call) === "S2" ? { files: { "b/b.txt": "b\n" }, usage } : firstPass(call);
    });

    const report = await run();

    expect(followUps(runner)[0]?.attempts).toHaveLength(1);
    expect(subtask(report.log, "S2")).toMatchObject({ state: "blocked", blockType: "limit", block: { type: "subtask-tokens" } });
    expect(report.result).toBe("draft");
  });

  it("should keep counting the wall clock of the subtask across its follow-ups", async () => {
    const repo = await target("limits: { subtaskWallClockMs: 60 * 60 * 1000 }");
    const { run, runner, clock } = harness(repo, (call) => {
      clock.advance(40 * 60 * 1000);
      if (call.spec.id.includes("followup")) {
        return call.number === 1 ? { files: { "a/a.txt": "changed\n" } } : { files: { "a/a.txt": "a\n", "ok-A2": "ok\n" } };
      }
      return firstPass(call);
    });

    const report = await run();

    expect(followUps(runner)[0]?.attempts).toHaveLength(1);
    expect(subtask(report.log, "S2")?.block?.type).toBe("subtask-wall-clock");
  });

  it("should keep counting patience across follow-ups, so a follow-up that repeats the failure of the first pass stops sooner", async () => {
    const repo = await target("", [{ name: "no-bad", command: "! grep -qs BAD b/b.txt" }]);
    const { run, runner } = harness(repo, (call) => {
      if (call.spec.id.includes("followup")) return { files: { "b/b.txt": "BAD again\n" } };
      if (subtaskOf(call) === "S2") return { files: { "b/b.txt": call.number <= 2 ? `BAD ${call.number}\n` : "b\n" } };
      return firstPass(call);
    });

    const report = await run();

    expect(subtask(report.log, "S2")).toMatchObject({ state: "blocked", blockType: "patience" });
    expect(followUps(runner)[0]?.attempts).toHaveLength(1);
  });
});

describe("factory run: tests that existed before the run", () => {
  async function withExistingTest(repo: Awaited<ReturnType<typeof target>>) {
    await git(repo.repoDir, "switch", "-q", BRANCH);
    await writeFile(join(repo.repoDir, "b-old.test.ts"), "export const old = 1;\n");
    await git(repo.repoDir, "add", ".");
    await git(repo.repoDir, "commit", "-q", "-m", "Existing test");
    await git(repo.repoDir, "switch", "-q", "main");
  }

  it("should let a follow-up fix a test its own subtask wrote earlier in the run, because only the tests from before the run are fixed", async () => {
    const repo = await targetRepo({ config: configText(), issueBody: ISSUE_BODY, spec: SPEC });
    const { run } = harness(repo, (call) => {
      if (call.spec.id.includes("followup")) return { files: { "b/b.test.ts": "export const ok = 2;\n", "ok-A2": "ok\n" } };
      return subtaskOf(call) === "S2" ? { files: { "b/b.test.ts": "export const ok = 1;\n" } } : firstPass(call);
    });

    const report = await run();

    expect(report.result).toBe("ready");
    expect(await git(repo.repoDir, "show", `${BRANCH}:b/b.test.ts`)).toContain("ok = 2");
  });

  it("should still reject a follow-up that changes a test which existed before the run", async () => {
    const repo = await targetRepo({ config: configText(), issueBody: ISSUE_BODY, spec: SPEC });
    await withExistingTest(repo);
    const { run } = harness(repo, (call) =>
      call.spec.id.includes("followup")
        ? { files: { "b-old.test.ts": "export const old = 2;\n", "ok-A2": "ok\n" } }
        : firstPass(call),
    );

    const report = await run();

    const attempt = subtask(report.log, "S2")?.attempts.find((entry) => entry.failure !== undefined);
    expect(attempt?.failure?.description).toContain("it changes existing tests that the spec does not authorize");
    expect(subtask(report.log, "S2")?.state).toBe("blocked");
  });
});
