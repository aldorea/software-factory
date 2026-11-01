import { afterEach, describe, expect, it } from "vitest";
import type { RunLog } from "../../src/coordinator/run-log.ts";
import { handleRequest } from "../../src/web/handler.ts";
import { aRun, repoWithRuns, request, runPage, temp, visibleText } from "./web-helpers.ts";

afterEach(() => temp.removeAll());

const FAILURE: RunLog["publicationFailure"] = {
  phase: "integration-push",
  message: "ssh: connect to host github.com port 22: Operation timed out",
  at: "2026-10-24T07:30:00.000Z",
};

describe("a run whose publication failed in factory web", () => {
  it("should show not published in the list of runs, in place of the pull request", async () => {
    const dir = await repoWithRuns([{ log: aRun(0, { publicationFailure: FAILURE }) }, { log: aRun(1) }]);

    const { body } = await handleRequest(request(dir));

    expect(body.match(/<span class="badge bad">not published<\/span>/g)).toHaveLength(1);
  });

  it("should show the phase, the message, the time and the command that publishes again on the page of the run", async () => {
    const text = visibleText(await runPage(aRun(0, { issue: 27, publicationFailure: FAILURE })));

    expect(text).toContain("Sin publicar");
    expect(text).toContain("integration-push");
    expect(text).toContain("Operation timed out");
    expect(text).toContain("2026-10-24T07:30:00.000Z");
    expect(text).toContain("factory publish 27");
  });

  it("should escape the message of the failure", async () => {
    const body = await runPage(aRun(0, { publicationFailure: { ...FAILURE!, message: "<script>alert(1)</script>" } }));

    expect(body).not.toContain("<script>alert(1)</script>");
  });

  it("should count the runs not published in the statistics of the home page", async () => {
    const dir = await repoWithRuns([{ log: aRun(0, { publicationFailure: FAILURE }) }, { log: aRun(1) }]);

    const text = visibleText((await handleRequest(request(dir))).body);

    expect(text).toContain("Sin publicar 1");
  });

  it("should show nothing about a publication in a run that has no failure", async () => {
    const text = visibleText(await runPage(aRun(0)));

    expect(text).not.toContain("Sin publicar");
  });
});
