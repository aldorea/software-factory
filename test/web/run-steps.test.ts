import { describe, expect, it } from "vitest";
import { MERGED_EARLIER } from "../../src/coordinator/resume.ts";
import type { RunEntry } from "../../src/coordinator/run-history.ts";
import type { CheckRecord, RunLog, TesterRecord, VerificationRecord } from "../../src/coordinator/run-log.ts";
import { runSteps, type RunStep } from "../../src/web/run-steps.ts";
import { attemptRecord, subtaskRecord } from "../coordinator/run-log-fixtures.ts";
import { aRun, NOW } from "./web-helpers.ts";

const MINUTE = 60_000;
const TESTER = { agent: "claude-code" as const, model: "m" };

function entryOf(overrides: Partial<RunLog>, modifiedAt: Date = NOW): RunEntry {
  const log = aRun(0, { issue: 23, ...overrides });
  return { dir: log.runId, log, modifiedAt, logTimes: new Map() };
}

function check(name: string, passed: boolean): CheckRecord {
  return { name, command: `pnpm ${name}`, exitCode: passed ? 0 : 1, passed };
}

function verification(overrides: Partial<VerificationRecord> = {}): VerificationRecord {
  return { sha: "9f8e7d6", passed: true, checks: [check("test", true)], criteria: [], humanCriteria: [], ...overrides };
}

function tester(overrides: Partial<TesterRecord> = {}): TesterRecord {
  return { agent: TESTER, verdicts: [{ id: "A1", passed: true, observation: "ok", evidence: [] }], ...overrides };
}

function states(steps: RunStep[]): Array<[string, string]> {
  return steps.map((step) => [step.kind === "subtask" ? `subtask ${step.id}` : step.kind, step.state]);
}

describe("the steps of a run", () => {
  it("should give each subtask, the integrated verification, the acceptance tester and the publication of a ready run as passed", () => {
    const log = {
      result: "ready" as const,
      agents: { workers: TESTER, tester: TESTER, changes: [] },
      subtasks: [subtaskRecord("db"), subtaskRecord("health")],
      verification: verification({ tester: tester() }),
      pullRequest: { number: 7, url: "https://github.com/o/r/pull/7", draft: false },
    };

    expect(states(runSteps(entryOf(log), NOW))).toEqual([
      ["subtask db", "passed"],
      ["subtask health", "passed"],
      ["integrated-verification", "passed"],
      ["acceptance-tester", "passed"],
      ["publication", "passed"],
    ]);
  });

  it("should give a subtask with its attempts and its gate, and say when an earlier run merged it", () => {
    const gate = { sha: "abc", accepted: true, reasons: [], checks: [check("test", true)], criteria: [], verifier: [] };
    const log = {
      subtasks: [
        subtaskRecord("db", { state: "merged", reason: MERGED_EARLIER }),
        subtaskRecord("health", { attempts: [attemptRecord("claude-code", 1, 1), { ...attemptRecord("claude-code", 1, 1), number: 2 }], gate }),
      ],
    };

    expect(runSteps(entryOf(log), NOW).slice(0, 2)).toEqual([
      { kind: "subtask", id: "db", state: "passed", anchor: "step-subtask-db", mergedEarlier: true, attempts: 0, gate: null },
      { kind: "subtask", id: "health", state: "passed", anchor: "step-subtask-health", mergedEarlier: false, attempts: 2, gate: "accepted" },
    ]);
  });

  it("should give a blocked subtask as failed, and the steps after it as not run, because it stopped the run", () => {
    const log = {
      result: "draft" as const,
      subtasks: [subtaskRecord("db"), subtaskRecord("health", { state: "blocked", blockType: "patience" }), subtaskRecord("ui", { state: "not-started" })],
    };

    expect(states(runSteps(entryOf(log), NOW))).toEqual([
      ["subtask db", "passed"],
      ["subtask health", "failed"],
      ["subtask ui", "not-run"],
      ["integrated-verification", "not-run"],
      ["publication", "not-run"],
    ]);
  });

  it("should give the steps of a run in progress as running or pending, since run.json does not record them yet", () => {
    const log = {
      result: "running" as const,
      agents: { workers: TESTER, tester: TESTER, changes: [] },
      subtasks: [subtaskRecord("db"), subtaskRecord("health", { state: "working" }), subtaskRecord("ui", { state: "pending" })],
    };

    expect(states(runSteps(entryOf(log), NOW))).toEqual([
      ["subtask db", "passed"],
      ["subtask health", "running"],
      ["subtask ui", "pending"],
      ["integrated-verification", "pending"],
      ["acceptance-tester", "pending"],
      ["publication", "pending"],
    ]);
  });

  it("should give the integrated verification as running while it checks, with the checks and criteria that pass so far", () => {
    const log = {
      result: "running" as const,
      subtasks: [subtaskRecord("db")],
      verificationProgress: { sha: "abc", checks: [check("lint", true), check("test", false)], criteria: [], current: { kind: "check" as const, name: "build" } },
    };

    expect(runSteps(entryOf(log), NOW)[1]).toEqual({
      kind: "integrated-verification",
      state: "running",
      anchor: "verification",
      checks: { passed: 1, total: 2 },
      criteria: { passed: 0, total: 0 },
    });
  });

  it("should give the integrated verification as failed when a check or a criterion fails, though the acceptance tester then does not run", () => {
    const log = {
      result: "draft" as const,
      agents: { workers: TESTER, tester: TESTER, changes: [] },
      verification: verification({ passed: false, checks: [check("test", false)] }),
    };

    expect(states(runSteps(entryOf(log), NOW)).slice(1)).toEqual([
      ["integrated-verification", "failed"],
      ["acceptance-tester", "not-run"],
      ["publication", "not-run"],
    ]);
  });

  it("should give the acceptance tester as running in its phase, and as failed with its verdicts when one fails", () => {
    const running = {
      result: "running" as const,
      agents: { workers: TESTER, tester: TESTER, changes: [] },
      verification: { ...verification(), testerPhase: "start" as const, testerStartedAt: NOW.toISOString() },
    };
    const failed = {
      result: "draft" as const,
      agents: { workers: TESTER, tester: TESTER, changes: [] },
      verification: verification({ passed: false, tester: tester({ verdicts: [{ id: "A1", passed: false, observation: "no", evidence: [] }, { id: "A2", passed: true, observation: "ok", evidence: [] }] }) }),
    };

    expect(runSteps(entryOf(running), NOW).find((step) => step.kind === "acceptance-tester")).toEqual({
      kind: "acceptance-tester",
      state: "running",
      anchor: "tester",
      phase: "start",
      verdicts: { passed: 0, total: 0 },
      error: null,
    });
    expect(runSteps(entryOf(failed), NOW).find((step) => step.kind === "acceptance-tester")).toEqual({
      kind: "acceptance-tester",
      state: "failed",
      anchor: "tester",
      phase: null,
      verdicts: { passed: 1, total: 2 },
      error: null,
    });
  });

  it("should give the publication as failed with its message, and not run for a paused run", () => {
    const unpublished = { result: "draft" as const, publicationFailure: { phase: "pull-request" as const, message: "gh: HTTP 502", at: "2026-10-24T07:00:00.000Z" } };
    const paused = { result: "paused" as const, subtasks: [subtaskRecord("db", { state: "interrupted" })] };

    expect(runSteps(entryOf(unpublished), NOW).at(-1)).toEqual({ kind: "publication", state: "failed", anchor: "step-publication", pullRequest: null, failure: "gh: HTTP 502" });
    expect(states(runSteps(entryOf(paused), NOW))).toEqual([
      ["subtask db", "not-run"],
      ["integrated-verification", "not-run"],
      ["publication", "not-run"],
    ]);
  });

  it("should give the pull request of the publication", () => {
    const log = { result: "draft" as const, pullRequest: { number: 7, url: "javascript:alert(1)", draft: true } };

    expect(runSteps(entryOf(log), NOW).at(-1)).toEqual({
      kind: "publication",
      state: "passed",
      anchor: "step-publication",
      pullRequest: { number: 7, url: null, draft: true },
      failure: null,
    });
  });

  it("should not call running the steps of an abandoned run, because nothing works on them any more", () => {
    const log = { result: "running" as const, attemptIdleTimeoutMs: 10 * MINUTE, subtasks: [subtaskRecord("health", { state: "working" }), subtaskRecord("ui", { state: "pending" })] };

    expect(states(runSteps(entryOf(log, new Date(NOW.getTime() - 11 * MINUTE)), NOW))).toEqual([
      ["subtask health", "not-run"],
      ["subtask ui", "not-run"],
      ["integrated-verification", "not-run"],
      ["publication", "not-run"],
    ]);
  });
});
