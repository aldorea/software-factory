import { describe, expect, it } from "vitest";
import { matchRoute, parseRunId } from "../../src/web/routes.ts";

const RUN_ID = "45-2026-10-24T08-00-00-000Z";

describe("parseRunId", () => {
  it("should accept the run ID that the coordinator builds from an issue and a time", () => {
    expect(parseRunId(RUN_ID)).toBe(RUN_ID);
  });

  it.each([
    "",
    "..",
    ".",
    "../45-2026-10-24T08-00-00-000Z",
    "45-2026-10-24T08-00-00-000Z/..",
    "45-2026-10-24T08-00-00-000Z/",
    "45-2026-10-24T08-00-00-000Z ",
    "45-2026-10-24T08-00-00-000Z\n",
    "45-2026-10-24T08-00-00-000Z\0",
    "45-2026-10-24T08-00-00-000Z\\x",
    "1-run-00",
    "-2026-10-24T08-00-00-000Z",
    "45-2026-10-24T08:00:00.000Z",
    "45-2026-10-24T08-00-00-000",
    "x45-2026-10-24T08-00-00-000Z",
    "<img src=x>",
  ])("should refuse %j, because it is not the format of a run ID", (candidate) => {
    expect(parseRunId(candidate)).toBeNull();
  });
});

describe("matchRoute", () => {
  it("should match the home page", () => {
    expect(matchRoute("/")).toEqual({ kind: "home" });
  });

  it("should match the page of a run", () => {
    expect(matchRoute(`/runs/${RUN_ID}`)).toEqual({ kind: "run", runId: RUN_ID });
  });

  it.each([
    "/runs",
    "/runs/",
    `/runs/${RUN_ID}/`,
    `/runs/${RUN_ID}//`,
    `/runs/${RUN_ID}//etc/passwd`,
    `/runs/${RUN_ID}/..`,
    `/runs/${RUN_ID}/a/../b`,
    `/runs/${RUN_ID}/%2e%2e/b`,
    `/runs/${RUN_ID}/.`,
    `/runs/${RUN_ID}/a/./b`,
    `/runs/${RUN_ID}/%2Fetc%2Fpasswd`,
    `/runs/${RUN_ID}/a%2Fb`,
    `/runs/${RUN_ID}/a%5Cb`,
    `/runs/${RUN_ID}/a%00b`,
    `/runs/${RUN_ID}/%zz`,
    "/runs/..",
    "/runs/../etc",
    "/runs/%2e%2e",
    "/runs/%2E%2E%2Fetc",
    `/runs/${RUN_ID}%2F..`,
    "/runs/%",
    "/runs/%zz",
    "/runs/%00",
    "/runs/1-run-00",
    `/Runs/${RUN_ID}`,
    "/nope",
  ])("should not match %s, so a malformed path fails closed", (path) => {
    expect(matchRoute(path)).toEqual({ kind: "not-found" });
  });

  it("should match a file of a run as the segments below the run ID", () => {
    expect(matchRoute(`/runs/${RUN_ID}/output/final/check-1-test.log`)).toEqual({
      kind: "log",
      runId: RUN_ID,
      segments: ["output", "final", "check-1-test.log"],
    });
  });

  it("should decode the segments of a file before it validates them", () => {
    expect(matchRoute(`/runs/${RUN_ID}/my%20file.log`)).toEqual({ kind: "log", runId: RUN_ID, segments: ["my file.log"] });
  });

  it("should decode the segment before it validates it", () => {
    expect(matchRoute(`/runs/${RUN_ID.replace(/-/g, "%2D")}`)).toEqual({ kind: "run", runId: RUN_ID });
  });
});
