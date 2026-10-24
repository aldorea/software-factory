import { afterEach, describe, expect, it } from "vitest";
import { SCOPE_REQUEST_MARKER } from "../../src/coordinator/worker-report.ts";
import type { AttemptScript } from "../fakes/worker-runner.ts";
import { BRANCH, CONFIG, git, harness, ISSUE, ISSUE_BODY, specText, targetRepo, temp } from "./harness.ts";

afterEach(() => temp.removeAll());

const WITH_BASE = {
  issueBody: ISSUE_BODY.replace("A1 The greeting says hello.", "A1 The greeting says hello.\n- [ ] A2 The farewell says bye."),
  spec: specText({
    files: { A1: ["requests/A1.request.test.ts", "src/greeting.txt"], A2: ["requests/A2.request.test.ts", "lib/farewell.txt"] },
    base: { id: "B", criteria: ["A1"], scope: ["requests/", "src/"], dependsOn: [], testChanges: [] },
    subtasks: [{ id: "S1", criteria: ["A2"], scope: ["lib/", "requests/"], dependsOn: [], testChanges: [] }],
    criteria: { A1: { evidence: "request", level: "subtask" }, A2: { evidence: "request", level: "subtask" } },
  }),
  config: CONFIG.replace('"grep -q hello src/greeting.txt"', '"true"').replace('"grep -q hello src/greeting.txt # {{id}}"', '"true # {{id}}"'),
};

const subtaskOf = (call: { spec: { id: string } }) => call.spec.id.replace(`${ISSUE}-`, "");

const baseWritesTheChecks: AttemptScript = () => ({
  files: { "requests/A1.request.test.ts": "check A1\n", "requests/A2.request.test.ts": "check A2\n", "src/greeting.txt": "hello\n" },
  commit: "Write the request checks",
});

describe("factory run: request checks with a base subtask", () => {
  it("should merge the request checks the base subtask writes and reject a worker that changes one, even inside its scope", async () => {
    const target = await targetRepo(WITH_BASE);
    const { run } = harness(target, (call) =>
      subtaskOf(call) === "B"
        ? baseWritesTheChecks(call)
        : { files: { "lib/farewell.txt": "bye\n", "requests/A2.request.test.ts": "weaker check\n" } },
    );

    const report = await run();

    const [base, worker] = report.log.subtasks;
    expect(base?.state).toBe("merged");
    expect(worker?.attempts[0]?.failure?.description).toContain(
      "it changes request checks, which only the base subtask writes: requests/A2.request.test.ts",
    );
    expect(worker).toMatchObject({ state: "blocked", blockType: "patience" });
    expect(await git(target.repoDir, "show", `${BRANCH}:requests/A2.request.test.ts`)).toBe("check A2");
  });

  it("should block at once a worker that asks to extend its scope to a request check", async () => {
    const target = await targetRepo({
      ...WITH_BASE,
      spec: WITH_BASE.spec.replace('"scope": [\n        "lib/",\n        "requests/"\n      ]', '"scope": [\n        "lib/"\n      ]'),
    });
    const { run, runner } = harness(target, (call) =>
      subtaskOf(call) === "B"
        ? baseWritesTheChecks(call)
        : { outcome: { kind: "completed", summary: `${SCOPE_REQUEST_MARKER} requests/A2.request.test.ts` } },
    );

    const report = await run();

    expect(runner.workers.find((worker) => worker.spec.id === `${ISSUE}-S1`)?.attempts).toHaveLength(1);
    expect(report.log.subtasks[1]).toMatchObject({
      state: "blocked",
      blockType: "scope",
      reason: "It needs requests/A2.request.test.ts, a request check that only the base subtask writes.",
    });
  });
});
