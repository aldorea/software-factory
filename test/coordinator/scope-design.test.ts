import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunLog } from "../../src/coordinator/run-log.ts";
import { DESIGN_QUESTION_MARKER, SCOPE_REQUEST_MARKER } from "../../src/coordinator/worker-report.ts";
import type { AttemptScript } from "../fakes/worker-runner.ts";
import { BRANCH, CONFIG, git, harness, ISSUE_BODY, specText, targetRepo, temp, writesHello } from "./harness.ts";

afterEach(() => temp.removeAll());

const TWO_SUBTASKS = {
  issueBody: ISSUE_BODY.replace("A1 The greeting says hello.", "A1 The greeting says hello.\n- [ ] A2 The farewell says bye."),
  spec: specText({
    files: { A1: ["src/greeting.txt"], A2: ["lib/farewell.txt"] },
    base: null,
    subtasks: [
      { id: "S1", criteria: ["A1"], scope: ["src/"], dependsOn: [], testChanges: [] },
      { id: "S2", criteria: ["A2"], scope: ["lib/"], dependsOn: [], testChanges: [] },
    ],
    criteria: { A1: { evidence: "request", level: "subtask" }, A2: { evidence: "request", level: "subtask" } },
  }),
  config: CONFIG.replace('"grep -q hello src/greeting.txt"', '"true"').replace('"grep -q hello src/greeting.txt # {{id}}"', '"true # {{id}}"'),
};

function asks(summary: string, then: AttemptScript = writesHello): AttemptScript {
  return (call) => (call.number === 1 ? { outcome: { kind: "completed", summary } } : then(call));
}

async function readRunLog(repoDir: string, runId: string): Promise<RunLog> {
  return JSON.parse(await readFile(join(repoDir, ".factory", "logs", runId, "run.json"), "utf8")) as RunLog;
}

describe("factory run: scope extension requests", () => {
  it("should extend the scope for a free, unprotected file and let the next attempt change it", async () => {
    const target = await targetRepo();
    const { run, runner } = harness(
      target,
      asks(`I need a file.\n${SCOPE_REQUEST_MARKER} docs/notes.md`, () => ({
        files: { "src/greeting.txt": "hello\n", "docs/notes.md": "notes\n" },
      })),
    );

    const report = await run();

    expect(report.result).toBe("ready");
    expect(runner.workers[0]?.attempts).toHaveLength(2);
    expect(await git(target.repoDir, "show", `${BRANCH}:docs/notes.md`)).toBe("notes");
    expect(report.log.subtasks[0]).toMatchObject({ state: "merged", scopeExtensions: ["docs/notes.md"] });
    expect(report.log.friction.scopeExtensions).toBe(1);
  });

  it("should tell the next attempt which paths it may now change", async () => {
    const target = await targetRepo();
    const { run, runner } = harness(target, asks(`${SCOPE_REQUEST_MARKER} docs/notes.md`));

    await run();

    const prompts = runner.workers[0]?.attempts.map((attempt) => attempt.prompt) ?? [];
    expect(prompts[0]).not.toContain("Scope extended");
    expect(prompts[1]).toContain("Scope extended");
    expect(prompts[1]).toContain("- docs/notes.md");
  });

  it("should not run the gate for the attempt that asked, because the worker did not finish", async () => {
    const target = await targetRepo();
    const { run, runner } = harness(target, asks(`${SCOPE_REQUEST_MARKER} docs/notes.md`));

    await run();

    const gates = runner.workers.filter((worker) => worker.spec.id.includes("gate"));
    expect(gates).toHaveLength(1);
    expect(gates[0]?.spec.id).toContain("S1-gate-2");
  });

  it("should list the scope extensions in the pull request and in run.json and leave specs/42.md as approved", async () => {
    const target = await targetRepo();
    const specBefore = await git(target.repoDir, "show", `${BRANCH}:specs/42.md`);
    const { run } = harness(target, asks(`${SCOPE_REQUEST_MARKER} docs/notes.md`));

    const report = await run();

    expect(target.github.pullRequests[0]?.body).toContain("## Scope extensions");
    expect(target.github.pullRequests[0]?.body).toContain("- **S1**: `docs/notes.md`");
    expect((await readRunLog(target.repoDir, report.log.runId)).subtasks[0]?.scopeExtensions).toEqual(["docs/notes.md"]);
    expect(await git(target.repoDir, "show", `${BRANCH}:specs/42.md`)).toBe(specBefore);
  });

  it("should block the subtask with the reason when a subtask of the same wave owns the file, and let the other subtask go on", async () => {
    const target = await targetRepo(TWO_SUBTASKS);
    const { run, runner } = harness(target, (call) =>
      call.spec.id.endsWith("S1")
        ? { outcome: { kind: "completed", summary: `${SCOPE_REQUEST_MARKER} lib/farewell.txt` } }
        : { files: { "lib/farewell.txt": "bye\n" } },
    );

    const report = await run();

    const [s1, s2] = report.log.subtasks;
    expect(runner.workers.find((worker) => worker.spec.id.endsWith("S1"))?.attempts).toHaveLength(1);
    expect(s1).toMatchObject({
      state: "blocked",
      blockType: "scope",
      reason: "It needs lib/farewell.txt, which S2 of the same wave owns.",
      block: { type: "scope", reason: "It needs lib/farewell.txt, which S2 of the same wave owns." },
      scopeExtensions: [],
    });
    expect(s2?.state).toBe("merged");
    expect(report.log.friction.blocks.scope).toBe(1);
    expect(report.result).toBe("draft");
    expect(target.github.pullRequests[0]?.draft).toBe(true);
    expect(target.github.pullRequests[0]?.body).toContain("which S2 of the same wave owns");
  });

  it("should give a file to the first subtask of a wave that asks for it and block the second, because the first one now owns it", async () => {
    const target = await targetRepo(TWO_SUBTASKS);
    const { run } = harness(target, (call) => {
      if (call.number === 1) return { outcome: { kind: "completed", summary: `${SCOPE_REQUEST_MARKER} docs/shared.md` } };
      return call.spec.id.endsWith("S1")
        ? { files: { "src/greeting.txt": "hello\n", "docs/shared.md": "shared\n" } }
        : { files: { "lib/farewell.txt": "bye\n" } };
    });

    const report = await run();

    const [s1, s2] = report.log.subtasks;
    expect(s1).toMatchObject({ state: "merged", scopeExtensions: ["docs/shared.md"] });
    expect(s2).toMatchObject({
      state: "blocked",
      blockType: "scope",
      reason: "It needs docs/shared.md, which S1 of the same wave owns.",
      scopeExtensions: [],
    });
  });

  it("should block the subtask when the file is protected, and not change the scope", async () => {
    const target = await targetRepo();
    const { run, runner } = harness(target, () => ({
      outcome: { kind: "completed", summary: `${SCOPE_REQUEST_MARKER} package.json` },
    }));

    const report = await run();

    expect(runner.workers[0]?.attempts).toHaveLength(1);
    expect(report.log.subtasks[0]).toMatchObject({
      state: "blocked",
      blockType: "scope",
      reason: "It needs package.json, which is a protected path.",
      scopeExtensions: [],
    });
    expect(target.github.pullRequests[0]?.body).toContain("It needs package.json, which is a protected path.");
  });

  it("should block at once a request for a test that existed before the run, instead of extending the scope and failing at the gate", async () => {
    const target = await targetRepo();
    await git(target.repoDir, "switch", "-q", BRANCH);
    await writeFile(join(target.repoDir, "old.test.ts"), "export const old = 1;\n");
    await git(target.repoDir, "add", ".");
    await git(target.repoDir, "commit", "-q", "-m", "Existing test");
    await git(target.repoDir, "switch", "-q", "main");
    const { run, runner } = harness(target, () => ({
      outcome: { kind: "completed", summary: `${SCOPE_REQUEST_MARKER} old.test.ts` },
    }));

    const report = await run();

    expect(runner.workers[0]?.attempts).toHaveLength(1);
    expect(report.log.subtasks[0]).toMatchObject({ state: "blocked", blockType: "scope", scopeExtensions: [] });
    expect(report.log.subtasks[0]?.reason).toContain("a test that existed before the run");
  });

  it("should treat the .factory folder as protected, because a worker cannot change the limits of its own run", async () => {
    const target = await targetRepo();
    const { run } = harness(target, () => ({
      outcome: { kind: "completed", summary: `${SCOPE_REQUEST_MARKER} .factory/config.ts` },
    }));

    const report = await run();

    expect(report.log.subtasks[0]).toMatchObject({ state: "blocked", blockType: "scope" });
  });

  it("should count a request for a file the scope already covers as a failed attempt, so that patience ends the loop", async () => {
    const target = await targetRepo();
    const { run, runner } = harness(target, () => ({
      outcome: { kind: "completed", summary: `${SCOPE_REQUEST_MARKER} src/other.ts` },
    }));

    const report = await run();

    expect(runner.workers[0]?.attempts).toHaveLength(3);
    expect(runner.workers[0]?.attempts[1]?.prompt).toContain("src/other.ts");
    expect(runner.workers[0]?.attempts[1]?.prompt).toContain("already cover it");
    expect(report.log.subtasks[0]).toMatchObject({ state: "blocked", blockType: "patience", scopeExtensions: [] });
  });
});

describe("factory run: design questions", () => {
  it("should block the subtask at once with no further attempt and put the question in the pull request", async () => {
    const target = await targetRepo();
    const { run, runner } = harness(target, () => ({
      outcome: { kind: "completed", summary: `${DESIGN_QUESTION_MARKER} Should the greeting be localized?` },
    }));

    const report = await run();

    expect(runner.workers[0]?.attempts).toHaveLength(1);
    expect(report.log.subtasks[0]).toMatchObject({
      state: "blocked",
      blockType: "design-question",
      reason: "The worker asked a question of design or product: Should the greeting be localized?",
      block: { type: "design-question" },
    });
    expect(report.log.friction.blocks["design-question"]).toBe(1);
    expect(report.result).toBe("draft");
    expect(target.github.pullRequests[0]?.body).toContain("Should the greeting be localized?");
    expect(runner.workers.filter((worker) => worker.spec.id.includes("gate"))).toHaveLength(0);
  });

  it("should not merge the work of a subtask that asked a design question, even when it committed and its checks pass", async () => {
    const target = await targetRepo();
    const { run } = harness(target, () => ({
      files: { "src/greeting.txt": "hello\n" },
      outcome: { kind: "completed", summary: `${DESIGN_QUESTION_MARKER} Which locale?` },
    }));

    await run();

    expect(await git(target.repoDir, "ls-tree", "-r", "--name-only", BRANCH)).not.toContain("src/greeting.txt");
  });

  it("should take the design question first when the summary also asks for a file, and extend nothing", async () => {
    const target = await targetRepo();
    const { run, runner } = harness(target, () => ({
      outcome: {
        kind: "completed",
        summary: `${SCOPE_REQUEST_MARKER} docs/notes.md\n${DESIGN_QUESTION_MARKER} Which locale?`,
      },
    }));

    const report = await run();

    expect(runner.workers[0]?.attempts).toHaveLength(1);
    expect(report.log.subtasks[0]).toMatchObject({ blockType: "design-question", scopeExtensions: [] });
  });

  it("should let the subtasks that do not depend on the blocked one go on", async () => {
    const target = await targetRepo(TWO_SUBTASKS);
    const { run } = harness(target, (call) =>
      call.spec.id.endsWith("S1")
        ? { outcome: { kind: "completed", summary: `${DESIGN_QUESTION_MARKER} Which locale?` } }
        : { files: { "lib/farewell.txt": "bye\n" } },
    );

    const report = await run();

    expect(report.log.subtasks.map((subtask) => subtask.state)).toEqual(["blocked", "merged"]);
  });
});

describe("the worker prompt", () => {
  it("should explain both markers", async () => {
    const target = await targetRepo();
    const { run, runner } = harness(target, writesHello);

    await run();

    const prompt = runner.workers[0]?.attempts[0]?.prompt ?? "";
    expect(prompt).toContain(`${SCOPE_REQUEST_MARKER} <path>`);
    expect(prompt).toContain(`${DESIGN_QUESTION_MARKER} <question>`);
  });
});
