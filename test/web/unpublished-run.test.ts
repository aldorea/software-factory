import { afterEach, describe, expect, it } from "vitest";
import type { RunLog } from "../../src/coordinator/run-log.ts";
import type { RunsResponse } from "../../src/web/api.ts";
import { handleRequest } from "../../src/web/handler.ts";
import { aRun, repoWithRuns, request, runDetail, temp } from "./web-helpers.ts";

afterEach(() => temp.removeAll());

const FAILURE: RunLog["publicationFailure"] = {
  phase: "integration-push",
  message: "ssh: connect to host github.com port 22: Operation timed out",
  at: "2026-10-24T07:30:00.000Z",
};

describe("a run whose publication failed in factory web", () => {
  it("should give not published in the list of runs of the API, in place of the pull request", async () => {
    const dir = await repoWithRuns([{ log: aRun(0, { publicationFailure: FAILURE }) }, { log: aRun(1) }]);

    const { runs } = JSON.parse(String((await handleRequest(request(dir, "/api/runs"))).body)) as RunsResponse;

    expect(runs.map((row) => row.pullRequest.kind)).toEqual(["none", "not-published"]);
  });

  it("should give the phase, the message, the time and the command that publishes again in the run of the API", async () => {
    const { publicationFailure } = await runDetail(aRun(0, { issue: 27, publicationFailure: FAILURE }));

    expect(publicationFailure).toEqual({ ...FAILURE, command: "factory publish 27" });
  });

  it("should count the runs not published in the statistics of the API", async () => {
    const dir = await repoWithRuns([{ log: aRun(0, { publicationFailure: FAILURE }) }, { log: aRun(1) }]);

    const { stats } = JSON.parse(String((await handleRequest(request(dir, "/api/runs"))).body)) as RunsResponse;

    expect(stats?.unpublished).toBe(1);
  });

  it("should give no publication failure for a run that has none", async () => {
    expect((await runDetail(aRun(0))).publicationFailure).toBeNull();
  });
});
