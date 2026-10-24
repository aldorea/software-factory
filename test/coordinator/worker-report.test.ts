import { describe, expect, it } from "vitest";
import { DESIGN_QUESTION_MARKER, SCOPE_REQUEST_MARKER, parseWorkerReport } from "../../src/coordinator/worker-report.ts";

describe("parseWorkerReport", () => {
  it("should find nothing in a summary without markers", () => {
    expect(parseWorkerReport("I wrote the greeting and the checks pass.")).toEqual({ scopeRequests: [] });
  });

  it("should read one path per scope request line, in order", () => {
    const summary = [
      "I need two more files.",
      `${SCOPE_REQUEST_MARKER} docs/notes.md`,
      `${SCOPE_REQUEST_MARKER}   lib/util.ts  `,
    ].join("\n");

    expect(parseWorkerReport(summary)).toEqual({ scopeRequests: ["docs/notes.md", "lib/util.ts"] });
  });

  it("should strip the backticks a worker puts around a path", () => {
    expect(parseWorkerReport(`${SCOPE_REQUEST_MARKER} \`docs/notes.md\``)).toEqual({
      scopeRequests: ["docs/notes.md"],
    });
  });

  it("should read a design question up to the next blank line", () => {
    const summary = [
      `${DESIGN_QUESTION_MARKER} Should the greeting be localized?`,
      "The spec does not say which locales.",
      "",
      "Nothing else.",
    ].join("\n");

    expect(parseWorkerReport(summary)).toEqual({
      scopeRequests: [],
      designQuestion: "Should the greeting be localized? The spec does not say which locales.",
    });
  });

  it("should stop a design question at the next marker", () => {
    const summary = [`${DESIGN_QUESTION_MARKER} Which locale?`, `${SCOPE_REQUEST_MARKER} docs/notes.md`].join("\n");

    expect(parseWorkerReport(summary)).toEqual({ scopeRequests: ["docs/notes.md"], designQuestion: "Which locale?" });
  });

  it("should ignore a marker that is not at the start of a line, because the worker may quote its instructions", () => {
    const summary = `The prompt says to write ${SCOPE_REQUEST_MARKER} <path> when I need a file. I did not.`;

    expect(parseWorkerReport(summary)).toEqual({ scopeRequests: [] });
  });

  it("should ignore a scope request with no path", () => {
    expect(parseWorkerReport(`${SCOPE_REQUEST_MARKER}   `)).toEqual({ scopeRequests: [] });
  });

  it("should still report a design question that has no text, so that the subtask blocks", () => {
    expect(parseWorkerReport(`${DESIGN_QUESTION_MARKER}`)).toEqual({
      scopeRequests: [],
      designQuestion: "The worker gave no text for its question.",
    });
  });
});
