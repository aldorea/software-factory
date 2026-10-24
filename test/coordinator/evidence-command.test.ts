import { describe, expect, it } from "vitest";
import { evidenceCommand, evidenceProblems, gatePlan } from "../../src/coordinator/evidence.ts";
import type { Spec } from "../../src/spec/spec.ts";

describe("evidenceCommand", () => {
  it("should put the criterion ID in every placeholder of the command", () => {
    expect(evidenceCommand("npx playwright test -g {{id}} --output {{id}}", "A12")).toBe(
      "npx playwright test -g A12 --output A12",
    );
  });

  it("should refuse an ID that is not A and digits, because the command runs in a shell", () => {
    for (const id of ["A1; rm -rf /", "$(touch x)", "A1 B", "a1", "A", "A1\n"]) {
      expect(() => evidenceCommand("test -e ok-{{id}}", id)).toThrow(`${JSON.stringify(id)} is not a criterion ID`);
    }
  });

  it("should fail closed on a spec criterion with a malformed ID before any command is built", () => {
    const spec: Spec = {
      files: {},
      base: null,
      subtasks: [],
      criteria: { "A1`id`": { evidence: "request", level: "subtask" } },
    } as unknown as Spec;
    expect(() => gatePlan(spec, ["A1`id`"], { request: "test -e {{id}}" })).toThrow("is not a criterion ID");
  });

  it("should report a malformed criterion ID as a problem of the spec, so the run stops before any worker starts", () => {
    const spec = {
      files: {},
      base: null,
      subtasks: [],
      criteria: { "A1;x": { evidence: "request", level: "subtask" }, A2: { evidence: "request", level: "subtask" } },
    } as unknown as Spec;
    expect(evidenceProblems(spec, { request: "test -e {{id}}" })).toEqual(['"A1;x" is not a criterion ID']);
  });
});
