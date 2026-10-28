import { afterEach, describe, expect, it } from "vitest";
import type { VerificationRecord } from "../../src/coordinator/run-log.ts";
import { aRun, repoWithRuns, request, runPage, temp, visibleText } from "./run-page-helpers.ts";
import { handleRequest } from "../../src/web/handler.ts";

afterEach(() => temp.removeAll());

function verification(overrides: Partial<VerificationRecord> = {}): VerificationRecord {
  return { sha: "9f8e7d6", passed: false, checks: [], criteria: [], humanCriteria: [], ...overrides };
}

describe("the integrated verification of a run", () => {
  it("should show the sha, the result, the checks and the criteria", async () => {
    const log = aRun(0, {
      verification: verification({
        checks: [
          { name: "typecheck", command: "pnpm typecheck", exitCode: 0, passed: true },
          { name: "test", command: "pnpm test", exitCode: 1, passed: false, firstError: "2 tests failed" },
        ],
        criteria: [{ id: "C1", evidence: "playwright", command: "playwright test", exitCode: 1, passed: false }],
      }),
    });

    const text = visibleText(await runPage(log));

    expect(text).toContain("Integrated verification");
    expect(text).toContain("SHA: 9f8e7d6");
    expect(text).toContain("Resultado: falla");
    expect(text).toContain("typecheck: pasa");
    expect(text).toContain("test: falla");
    expect(text).toContain("2 tests failed");
    expect(text).toContain("C1: falla");
  });

  it("should show a passed verification as passed", async () => {
    const text = visibleText(await runPage(aRun(0, { verification: verification({ passed: true }) })));

    expect(text).toContain("Integrated verification");
    expect(text).toContain("Resultado: pasa");
  });

  it("should show each human criterion with its reason and attachments", async () => {
    const log = aRun(0, {
      verification: verification({
        humanCriteria: [{ id: "H1", reason: "the layout needs a human eye", attachments: ["screens/home.png", "screens/run.png"] }],
      }),
    });

    const text = visibleText(await runPage(log));

    expect(text).toContain("Criterios human");
    expect(text).toContain("H1: the layout needs a human eye");
    expect(text).toContain("screens/home.png");
    expect(text).toContain("screens/run.png");
  });

  it("should show the result of the acceptance tester with its agent, verdicts and error", async () => {
    const log = aRun(0, {
      verification: verification({
        tester: {
          agent: { agent: "claude-code", model: "sonnet" },
          verdicts: [
            { id: "C1", passed: true, observation: "the page loads", evidence: [] },
            { id: "C2", passed: false, observation: "the button is missing", evidence: ["shot.png"] },
          ],
          error: "the tester stopped early",
        },
      }),
    });

    const text = visibleText(await runPage(log));

    expect(text).toContain("Acceptance tester");
    expect(text).toContain("claude-code / sonnet");
    expect(text).toContain("C1: pasa (the page loads)");
    expect(text).toContain("C2: falla (the button is missing)");
    expect(text).toContain("shot.png");
    expect(text).toContain("Error: the tester stopped early");
  });

  it("should show the environment problem that kept the verification from running", async () => {
    const text = visibleText(await runPage(aRun(0, { verification: verification({ environment: "the dev server did not start" }) })));

    expect(text).toContain("Entorno: the dev server did not start");
  });

  it("should not fail and should say there is no verification yet when the run has none", async () => {
    const log = aRun(0, { result: "running" });
    const dir = await repoWithRuns([{ log }]);

    const response = await handleRequest(request(dir, `/runs/${log.runId}`));

    expect(response.status).toBe(200);
    expect(visibleText(response.body)).toContain("Integrated verification");
    expect(visibleText(response.body)).toContain("Todavía sin integrated verification");
  });

  it("should escape the text that the verification brings from run.json", async () => {
    const body = await runPage(aRun(0, { verification: verification({ humanCriteria: [{ id: "H1", reason: "<img src=x>", attachments: [] }] }) }));

    expect(body).not.toContain("<img src=x>");
  });
});
