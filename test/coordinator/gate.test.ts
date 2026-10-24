import { describe, expect, it } from "vitest";
import { covers, gateDecision, isTestFile, requestCheckPaths, type GateInput } from "../../src/coordinator/gate.ts";
import type { Spec } from "../../src/spec/spec.ts";
import type { CheckRecord } from "../../src/coordinator/run-log.ts";

const PASSING: CheckRecord = { name: "lint", command: "pnpm lint", exitCode: 0, passed: true };

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    changes: [],
    scope: ["src/greeting/"],
    protectedPaths: ["package.json", "pnpm-lock.yaml"],
    isBase: false,
    existingTestPaths: new Set(),
    authorizedTestChanges: [],
    requestCheckPaths: [],
    checks: [PASSING],
    ...overrides,
  };
}

function reasonsOf(overrides: Partial<GateInput>): string[] {
  return gateDecision(input(overrides)).reasons;
}

describe("gateDecision", () => {
  it("should accept a diff inside the scope whose checks pass", () => {
    const decision = gateDecision(input({ changes: [{ path: "src/greeting/hello.ts", status: "added" }] }));

    expect(decision).toMatchObject({ accepted: true, reasons: [], rejections: [] });
  });

  it("should reject a path outside the scope and name it", () => {
    const decision = gateDecision(
      input({
        changes: [
          { path: "src/greeting/hello.ts", status: "added" },
          { path: "src/other/a.ts", status: "modified" },
          { path: "README.md", status: "modified" },
        ],
      }),
    );

    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toEqual(["it touches paths outside its scope (src/greeting/): README.md, src/other/a.ts"]);
  });

  it("should not take a directory next to the scope for inside it", () => {
    expect(reasonsOf({ changes: [{ path: "src/greeting-extra/a.ts", status: "added" }] })).toHaveLength(1);
  });

  it("should reject a protected path of a subtask that is not the base, and name it once", () => {
    const reasons = reasonsOf({ changes: [{ path: "package.json", status: "modified" }] });

    expect(reasons).toEqual(["it touches protected paths: package.json"]);
  });

  it("should accept a protected path when the subtask is the base", () => {
    const decision = gateDecision(
      input({ isBase: true, scope: ["package.json"], changes: [{ path: "package.json", status: "modified" }] }),
    );

    expect(decision.accepted).toBe(true);
  });

  it("should always protect the .factory folder, because a worker must not change its own limits", () => {
    const reasons = reasonsOf({ changes: [{ path: ".factory/config.ts", status: "modified" }] });

    expect(reasons).toEqual(["it touches protected paths: .factory/config.ts"]);
  });

  it("should reject a change to a test file that existed before the run and name it", () => {
    const reasons = reasonsOf({
      existingTestPaths: new Set(["src/greeting/hello.test.ts"]),
      changes: [{ path: "src/greeting/hello.test.ts", status: "modified" }],
    });

    expect(reasons).toEqual(["it changes existing tests that the spec does not authorize: src/greeting/hello.test.ts"]);
  });

  it("should reject the deletion of a test file that existed before the run", () => {
    const reasons = reasonsOf({
      existingTestPaths: new Set(["src/greeting/hello.test.ts"]),
      changes: [{ path: "src/greeting/hello.test.ts", status: "deleted" }],
    });

    expect(reasons).toHaveLength(1);
  });

  it("should accept a change to an existing test that the spec authorizes", () => {
    const decision = gateDecision(
      input({
        existingTestPaths: new Set(["src/greeting/hello.test.ts"]),
        authorizedTestChanges: ["src/greeting/hello.test.ts"],
        changes: [{ path: "src/greeting/hello.test.ts", status: "modified" }],
      }),
    );

    expect(decision.accepted).toBe(true);
  });

  it("should accept a new test file, because only the tests that existed before the run are fixed", () => {
    const decision = gateDecision(
      input({ changes: [{ path: "src/greeting/new.test.ts", status: "added" }], existingTestPaths: new Set(["src/greeting/hello.test.ts"]) }),
    );

    expect(decision.accepted).toBe(true);
  });

  it("should reject a change to a request check of a subtask that is not the base, even in its scope", () => {
    const reasons = reasonsOf({
      requestCheckPaths: ["src/greeting/hello.request.test.ts"],
      changes: [{ path: "src/greeting/hello.request.test.ts", status: "added" }],
    });

    expect(reasons).toEqual(["it changes request checks, which only the base subtask writes: src/greeting/hello.request.test.ts"]);
  });

  it("should accept a change to a request check when the subtask is the base", () => {
    const decision = gateDecision(
      input({
        isBase: true,
        scope: ["src/"],
        requestCheckPaths: ["src/greeting/hello.request.test.ts"],
        changes: [{ path: "src/greeting/hello.request.test.ts", status: "added" }],
      }),
    );

    expect(decision.accepted).toBe(true);
  });

  it("should give one reason per kind of forbidden change, with the failed checks after them", () => {
    const decision = gateDecision(
      input({
        changes: [
          { path: "package.json", status: "modified" },
          { path: "docs/a.md", status: "added" },
        ],
        checks: [{ name: "lint", command: "pnpm lint", exitCode: 1, passed: false, firstError: "src/a.ts: unused variable" }],
      }),
    );

    expect(decision.reasons).toEqual([
      "it touches protected paths: package.json",
      "it touches paths outside its scope (src/greeting/): docs/a.md",
      "check lint failed with exit code 1: src/a.ts: unused variable",
    ]);
  });

  it("should reject a failed criterion with its ID in the reason and in the signature", () => {
    const decision = gateDecision(
      input({ criteria: [{ id: "A2", evidence: "request", command: "curl", exitCode: 22, passed: false }] }),
    );

    expect(decision.reasons).toEqual(["criterion A2 (request) failed with exit code 22"]);
    expect(decision.signature).toBe("criterion:A2");
  });

  it("should give the same signature to the same rejection and a different one to another", () => {
    const first = gateDecision(input({ changes: [{ path: "docs/a.md", status: "added" }] }));
    const again = gateDecision(input({ changes: [{ path: "docs/a.md", status: "modified" }] }));
    const other = gateDecision(input({ changes: [{ path: "docs/b.md", status: "added" }] }));

    expect(again.signature).toBe(first.signature);
    expect(other.signature).not.toBe(first.signature);
  });

  it("should sign a failed check by its name and first error line, whatever the exit code", () => {
    const failing = (exitCode: number, firstError: string): GateInput =>
      input({ checks: [{ name: "tests", command: "pnpm test", exitCode, passed: false, firstError }] });

    expect(gateDecision(failing(1, "FAIL a.test.ts")).signature).toBe(gateDecision(failing(2, "FAIL a.test.ts")).signature);
    expect(gateDecision(failing(1, "FAIL a.test.ts")).signature).not.toBe(gateDecision(failing(1, "FAIL b.test.ts")).signature);
  });
});

describe("covers", () => {
  it("should cover a path by the same path, by a folder that holds it and by nothing else", () => {
    expect(covers("src/a.ts", "src/a.ts")).toBe(true);
    expect(covers("src/", "src/a/b.ts")).toBe(true);
    expect(covers("./src", "src/a.ts")).toBe(true);
    expect(covers("src/a", "src/ab.ts")).toBe(false);
    expect(covers("src/a/b.ts", "src/a")).toBe(false);
  });
});

describe("isTestFile", () => {
  it("should recognize the conventional names and folders of tests", () => {
    for (const path of ["src/a.test.ts", "src/a.spec.tsx", "test/a.ts", "e2e/login.ts", "src/__tests__/a.ts", "tests/a/b.ts"]) {
      expect(isTestFile(path), path).toBe(true);
    }
    for (const path of ["src/a.ts", "src/latest.ts", "docs/testing.md"]) expect(isTestFile(path), path).toBe(false);
  });
});

describe("requestCheckPaths", () => {
  it("should list the test files of the criteria whose evidence is a request, and nothing else", () => {
    const spec: Spec = {
      files: {
        A1: ["src/api/hello.ts", "test/api/hello.request.test.ts"],
        A2: ["e2e/login.spec.ts"],
        A3: ["test/api/other.request.test.ts"],
      },
      base: null,
      subtasks: [],
      criteria: {
        A1: { evidence: "request", level: "subtask" },
        A2: { evidence: "playwright", level: "integration" },
        A3: { evidence: "request", level: "integration" },
      },
    };

    expect(requestCheckPaths(spec)).toEqual(["test/api/hello.request.test.ts", "test/api/other.request.test.ts"]);
  });
});
