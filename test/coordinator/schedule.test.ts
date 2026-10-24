import { describe, expect, it } from "vitest";
import { dependencyProblem, schedule } from "../../src/coordinator/schedule.ts";
import type { Spec, Subtask } from "../../src/spec/spec.ts";

function subtask(id: string, scope: string[], dependsOn: string[] = []): Subtask {
  return { id, criteria: [], scope, dependsOn, testChanges: [] };
}

function spec(subtasks: Subtask[], base: Subtask | null = null): Spec {
  return { files: {}, base, subtasks, criteria: {} };
}

function ids(waves: Subtask[][]): string[][] {
  return waves.map((wave) => wave.map((item) => item.id));
}

describe("schedule", () => {
  it("should keep the base subtask out of the waves so that it runs first and alone", () => {
    const base = subtask("B", ["db/"]);

    const planned = schedule(spec([subtask("S1", ["a/"])], base));

    expect(planned.base?.id).toBe("B");
    expect(ids(planned.waves)).toEqual([["S1"]]);
  });

  it("should have no base and no wave for a spec with no subtasks", () => {
    expect(schedule(spec([]))).toEqual({ base: null, waves: [] });
  });

  it("should put subtasks with disjoint scope paths and no dependency in one wave, in spec order", () => {
    const planned = schedule(spec([subtask("S2", ["b/"]), subtask("S1", ["a/"]), subtask("S3", ["c/x.ts"])]));

    expect(ids(planned.waves)).toEqual([["S2", "S1", "S3"]]);
  });

  it("should run a subtask in a later wave than the subtask it depends on", () => {
    const planned = schedule(spec([subtask("S2", ["b/"], ["S1"]), subtask("S1", ["a/"])]));

    expect(ids(planned.waves)).toEqual([["S1"], ["S2"]]);
  });

  it("should run a subtask in a later wave than an earlier subtask whose scope overlaps its own, even when neither depends on the other", () => {
    const planned = schedule(
      spec([subtask("S1", ["src/"]), subtask("S2", ["src/api/users.ts"]), subtask("S3", ["docs/"])]),
    );

    expect(ids(planned.waves)).toEqual([["S1", "S3"], ["S2"]]);
  });

  it("should not treat a path that only shares a name prefix as an overlap", () => {
    const planned = schedule(spec([subtask("S1", ["src/api"]), subtask("S2", ["src/api-docs"])]));

    expect(ids(planned.waves)).toEqual([["S1", "S2"]]);
  });

  it("should not wait on the base subtask for a subtask that lists it as a dependency, because the base has merged before any wave", () => {
    const base = subtask("B", ["db/"]);

    const planned = schedule(spec([subtask("S1", ["a/"], ["B"])], base));

    expect(ids(planned.waves)).toEqual([["S1"]]);
  });

  it("should chain a dependency through several waves", () => {
    const planned = schedule(
      spec([subtask("S3", ["c/"], ["S2"]), subtask("S2", ["b/"], ["S1"]), subtask("S1", ["a/"]), subtask("S4", ["d/"])]),
    );

    expect(ids(planned.waves)).toEqual([["S1", "S4"], ["S2"], ["S3"]]);
  });

  it("should throw instead of looping when subtasks depend on each other in a cycle, because validation should have rejected the spec", () => {
    expect(() => schedule(spec([subtask("S1", ["a/"], ["S2"]), subtask("S2", ["b/"], ["S1"])]))).toThrow(
      "cannot be scheduled: S1, S2",
    );
  });
});

describe("dependencyProblem", () => {
  it("should accept a subtask with no dependency", () => {
    expect(dependencyProblem(subtask("S1", ["a/"]), new Map())).toBeNull();
  });

  it("should accept a subtask whose dependencies all merged", () => {
    const states = new Map([["S1", "merged" as const]]);

    expect(dependencyProblem(subtask("S2", ["b/"], ["S1"]), states)).toBeNull();
  });

  it("should say which dependency is blocked", () => {
    const states = new Map([["S1", "blocked" as const]]);

    expect(dependencyProblem(subtask("S2", ["b/"], ["S1"]), states)).toBe("It depends on S1, which is blocked.");
  });

  it("should say which dependency did not start, so that a chain of dependents all report their reason", () => {
    const states = new Map([["S2", "not-started" as const]]);

    expect(dependencyProblem(subtask("S3", ["c/"], ["S2"]), states)).toBe("It depends on S2, which did not start.");
  });

  it("should name every dependency that did not merge", () => {
    const states = new Map([
      ["S1", "blocked" as const],
      ["S2", "merged" as const],
      ["S3", "not-started" as const],
    ]);

    expect(dependencyProblem(subtask("S4", ["d/"], ["S1", "S2", "S3"]), states)).toBe(
      "It depends on S1, which is blocked, and S3, which did not start.",
    );
  });

  it("should ignore a dependency on the base subtask because the base merged before any wave", () => {
    expect(dependencyProblem(subtask("S1", ["a/"], ["B"]), new Map())).toBeNull();
  });
});
