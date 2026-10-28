import { describe, expect, it } from "vitest";
import { isInside, runLogSegments, runLogUrl, safeSegments } from "../../src/web/log-path.ts";

const RUN_DIR = "/repo/.factory/logs/45-2026-10-24T08-00-00-000Z";

describe("isInside", () => {
  it.each(["/run/a.log", "/run/output/a.log", "/run/..a.log", "/run/output/..hidden/a.log"])("should accept %s, a file below the run", (file) => {
    expect(isInside("/run", file)).toBe(true);
  });

  it.each([
    ["/run", "the run folder itself"],
    ["/", "the root"],
    ["/other/a.log", "a folder outside the run"],
    ["/run-other/a.log", "a sibling whose name starts like the run"],
    ["/run/../other/a.log", "a path that climbs out of the run"],
    ["/etc/passwd", "an absolute path elsewhere"],
  ])("should refuse %s, %s", (file) => {
    expect(isInside("/run", file)).toBe(false);
  });
});

describe("safeSegments", () => {
  it("should keep the segments of a plain relative path", () => {
    expect(safeSegments(["output", "final", "check-1-test.log"])).toEqual(["output", "final", "check-1-test.log"]);
  });

  it.each([
    [[]],
    [[""]],
    [["a", ""]],
    [[".."]],
    [["a", "..", "b"]],
    [["."]],
    [["a/b"]],
    [["a\\b"]],
    [["a\0b"]],
    [["/etc/passwd"]],
  ])("should refuse %j, because it can leave the run or is not a name", (segments) => {
    expect(safeSegments(segments)).toBeNull();
  });
});

describe("runLogSegments", () => {
  it("should accept an absolute path inside the run folder, as an attempt or a verifier record keeps it", () => {
    expect(runLogSegments(RUN_DIR, `${RUN_DIR}/S1-attempt-1.jsonl`)).toEqual(["S1-attempt-1.jsonl"]);
  });

  it("should accept a path relative to the run folder, as a check, a criterion or the tester keeps it", () => {
    expect(runLogSegments(RUN_DIR, "output/final/check-1-test.log")).toEqual(["output", "final", "check-1-test.log"]);
  });

  it("should normalise a path that stays inside the run", () => {
    expect(runLogSegments(RUN_DIR, "output/../S1-attempt-1.jsonl")).toEqual(["S1-attempt-1.jsonl"]);
    expect(runLogSegments(RUN_DIR, "./output/a.log")).toEqual(["output", "a.log"]);
    expect(runLogSegments(RUN_DIR, `${RUN_DIR}/output/../a.log`)).toEqual(["a.log"]);
  });

  it.each([
    ["an absolute path outside the run", "/logs/attempt.jsonl"],
    ["an absolute path in a sibling run", "/repo/.factory/logs/46-2026-10-24T08-00-00-000Z/a.log"],
    ["an absolute path whose name starts like the run", `${RUN_DIR}-copy/a.log`],
    ["an absolute path that climbs out of the run", `${RUN_DIR}/../../../../etc/passwd`],
    ["a relative path that climbs out of the run", "../46-2026-10-24T08-00-00-000Z/a.log"],
    ["a relative path that climbs out in the middle", "output/../../a.log"],
    ["the run folder itself", RUN_DIR],
    ["the current folder", "."],
    ["an empty path", ""],
    ["a path with a NUL byte", "output/a.log\0.txt"],
  ])("should refuse %s, so it is never linked", (_name, logPath) => {
    expect(runLogSegments(RUN_DIR, logPath)).toBeNull();
  });

  it("should refuse a path that is missing", () => {
    expect(runLogSegments(RUN_DIR, undefined)).toBeNull();
  });
});

describe("runLogUrl", () => {
  it("should build the path of a file of a run and encode each segment", () => {
    expect(runLogUrl("45-2026-10-24T08-00-00-000Z", ["output", "a b#c?.log"])).toBe("/runs/45-2026-10-24T08-00-00-000Z/output/a%20b%23c%3F.log");
  });
});
