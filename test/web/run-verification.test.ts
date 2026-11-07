import { afterEach, describe, expect, it } from "vitest";
import type { VerificationRecord } from "../../src/coordinator/run-log.ts";
import { aRun, runDetail, temp } from "./web-helpers.ts";

afterEach(() => temp.removeAll());

function verification(overrides: Partial<VerificationRecord> = {}): VerificationRecord {
  return { sha: "9f8e7d6", passed: false, checks: [], criteria: [], humanCriteria: [], ...overrides };
}

describe("the integrated verification of a run", () => {
  it("should give the sha, the result, the checks and the criteria", async () => {
    const log = aRun(0, {
      verification: verification({
        checks: [
          { name: "typecheck", command: "pnpm typecheck", exitCode: 0, passed: true },
          { name: "test", command: "pnpm test", exitCode: 1, passed: false, firstError: "2 tests failed" },
        ],
        criteria: [{ id: "C1", evidence: "playwright", command: "playwright test", exitCode: 1, passed: false }],
      }),
    });

    expect((await runDetail(log)).verification).toEqual({
      sha: "9f8e7d6",
      passed: false,
      environment: null,
      checks: [
        { name: "typecheck", command: "pnpm typecheck", exitCode: 0, passed: true, firstError: null, output: null, outputUrl: null },
        { name: "test", command: "pnpm test", exitCode: 1, passed: false, firstError: "2 tests failed", output: null, outputUrl: null },
      ],
      criteria: [{ id: "C1", command: "playwright test", exitCode: 1, passed: false, output: null, outputUrl: null, files: [] }],
      humanCriteria: [],
      tester: null,
    });
  });

  it("should give each human criterion with its reason and attachments", async () => {
    const humanCriteria = [{ id: "H1", reason: "the layout needs a human eye", attachments: ["screens/home.png", "screens/run.png"] }];

    expect((await runDetail(aRun(0, { verification: verification({ humanCriteria }) }))).verification?.humanCriteria).toEqual(humanCriteria.map((criterion) => ({ ...criterion, files: [] })));
  });

  it("should give the result of the acceptance tester with its agent, verdicts and error", async () => {
    const verdicts = [
      { id: "C1", passed: true, observation: "the page loads", evidence: [] },
      { id: "C2", passed: false, observation: "the button is missing", evidence: ["shot.png"] },
    ];
    const log = aRun(0, {
      verification: verification({ tester: { agent: { agent: "claude-code", model: "sonnet" }, verdicts, error: "the tester stopped early" } }),
    });

    expect((await runDetail(log)).verification?.tester).toEqual({
      agent: "claude-code",
      model: "sonnet",
      error: "the tester stopped early",
      checks: [],
      verdicts: verdicts.map((verdict) => ({ ...verdict, files: [] })),
    });
  });

  it("should give the environment problem that kept the verification from running", async () => {
    const log = aRun(0, { verification: verification({ environment: "the dev server did not start" }) });

    expect((await runDetail(log)).verification?.environment).toBe("the dev server did not start");
  });

  it("should give no verification, and not fail, when the run has none yet", async () => {
    expect((await runDetail(aRun(0, { result: "running" }))).verification).toBeNull();
  });
});
