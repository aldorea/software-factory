import { describe, expect, it } from "vitest";
import type { RunEntry } from "../../src/coordinator/run-history.ts";
import type { CheckRecord, CriterionRecord, RunLog, VerificationRecord } from "../../src/coordinator/run-log.ts";
import { runCauses } from "../../src/web/run-causes.ts";
import { subtaskRecord } from "../coordinator/run-log-fixtures.ts";
import { aRun, NOW } from "./web-helpers.ts";

const MINUTE = 60_000;

function entryOf(overrides: Partial<RunLog>, modifiedAt: Date = NOW): RunEntry {
  const log = aRun(0, { issue: 23, ...overrides });
  return { dir: log.runId, log, modifiedAt, logTimes: new Map() };
}

function verification(overrides: Partial<VerificationRecord> = {}): VerificationRecord {
  return { sha: "9f8e7d6", passed: false, checks: [], criteria: [], humanCriteria: [], ...overrides };
}

function failedCheck(name: string, firstError: string): CheckRecord {
  return { name, command: `pnpm ${name}`, exitCode: 1, passed: false, firstError };
}

function criterion(id: string, passed: boolean): CriterionRecord {
  return { id, evidence: "playwright", command: `playwright test ${id}`, exitCode: passed ? 0 : 1, passed, ...(passed ? {} : { outputTail: `${id} failed` }) };
}

const NEW_RUN = { kind: "command", purpose: "new-run", command: "run", issue: 23, flags: [], text: "factory run 23" };
const REVIEW_SPEC = { kind: "review-spec", issue: 23, text: "Revisa la spec y empieza un run nuevo" };

describe("the causes of a run", () => {
  it("should give no cause for a ready run", () => {
    expect(runCauses(entryOf({ result: "ready" }), NOW)).toEqual([]);
  });

  it("should give no cause for a run that works, since Summary then shows only its current step", () => {
    const log = { result: "running" as const, pauseReason: "x", block: { type: "integration-check" as const, reason: "r", sha: "s", checks: [] } };

    expect(runCauses(entryOf(log), NOW)).toEqual([]);
  });

  it("should give an abandoned run as its first cause, with a new run as its next step, in which the merged subtasks do not run again", () => {
    const causes = runCauses(entryOf({ result: "running", attemptIdleTimeoutMs: 10 * MINUTE }, new Date(NOW.getTime() - 11 * MINUTE)), NOW);

    expect(causes).toEqual([
      {
        kind: "abandoned",
        where: "Run",
        what: "abandonado",
        detail: "Ni run.json ni sus raw logs han cambiado en más de 10 min",
        evidence: null,
        next: NEW_RUN,
      },
    ]);
  });

  it("should give a paused run with the reason and the reset of the plan limit, and resume it with the same command", () => {
    const causes = runCauses(entryOf({ result: "paused", pauseReason: "the plan limit of claude-code was reached", resetsAt: "2026-10-24T12:00:00.000Z" }), NOW);

    expect(causes).toEqual([
      {
        kind: "paused",
        where: "Run",
        what: "pausado hasta 2026-10-24T12:00:00.000Z",
        detail: "the plan limit of claude-code was reached",
        evidence: null,
        next: { kind: "command", purpose: "resume", command: "run", issue: 23, flags: [], text: "factory run 23" },
      },
    ]);
  });

  it("should give a publication that failed with its phase and message, and publish it again", () => {
    const causes = runCauses(
      entryOf({ result: "draft", publicationFailure: { phase: "pull-request", message: "gh: HTTP 502", at: "2026-10-24T07:00:00.000Z" } }),
      NOW,
    );

    expect(causes).toEqual([
      {
        kind: "publication-failed",
        where: "Publicación",
        what: "falló en pull-request",
        detail: "gh: HTTP 502",
        evidence: { tab: "steps", anchor: "step-publication" },
        next: { kind: "command", purpose: "publish", command: "publish", issue: 23, flags: [], text: "factory publish 23" },
      },
    ]);
  });

  it("should give the block of the run and say to review the spec, because an integration check needs a change of the spec", () => {
    const block = { type: "integration-check" as const, reason: "lint fails on the integrated branch", sha: "abc", checks: [failedCheck("lint", "no-unused-vars")] };

    expect(runCauses(entryOf({ result: "draft", block }), NOW)).toEqual([
      {
        kind: "run-block",
        where: "Run",
        what: "bloqueado (integration-check)",
        detail: "lint fails on the integrated branch",
        evidence: { tab: "summary", anchor: "run-block" },
        next: REVIEW_SPEC,
      },
    ]);
  });

  it("should give each blocked subtask with its type and its last failure, before the verification", () => {
    const subtasks = [
      subtaskRecord("health", { state: "blocked", blockType: "patience", reason: "5 attempts with the same failure", block: { type: "patience", reason: "5 attempts", lastFailure: "test: expected 200, got 500" } }),
      subtaskRecord("db", { state: "merged" }),
      subtaskRecord("ui", { state: "blocked", blockType: "scope", reason: "needs src/server" }),
    ];

    expect(runCauses(entryOf({ result: "draft", subtasks, verification: verification({ checks: [failedCheck("test", "1 failed")] }) }), NOW)).toEqual([
      {
        kind: "blocked-subtask",
        where: "Subtask health",
        what: "blocked (patience)",
        detail: "test: expected 200, got 500",
        evidence: { tab: "subtasks", anchor: "subtask-health" },
        next: REVIEW_SPEC,
      },
      {
        kind: "blocked-subtask",
        where: "Subtask ui",
        what: "blocked (scope)",
        detail: "needs src/server",
        evidence: { tab: "subtasks", anchor: "subtask-ui" },
        next: REVIEW_SPEC,
      },
      {
        kind: "failed-check",
        where: "Integrated verification · check test",
        what: "falla",
        detail: "1 failed",
        evidence: { tab: "verification", anchor: "verification-check-test" },
        next: REVIEW_SPEC,
      },
    ]);
  });

  it("should start a new run for a subtask blocked by the environment, which a new run can find fixed", () => {
    const subtasks = [subtaskRecord("health", { state: "blocked", blockType: "environment", reason: "docker is not running" })];

    expect(runCauses(entryOf({ result: "draft", subtasks }), NOW).map((cause) => cause.next)).toEqual([NEW_RUN]);
  });

  it("should give each failed criterion of the integrated verification with the link to its evidence", () => {
    const log = { result: "draft" as const, verification: verification({ criteria: [criterion("A1", true), criterion("A3", false)] }) };

    expect(runCauses(entryOf(log), NOW)).toEqual([
      {
        kind: "failed-criterion",
        where: "Integrated verification · A3",
        what: "falla",
        detail: "A3 failed",
        evidence: { tab: "verification", anchor: "verification-criterion-A3" },
        next: REVIEW_SPEC,
      },
    ]);
  });

  it("should give each verdict of the acceptance tester that failed with its observation", () => {
    const tester = {
      agent: { agent: "claude-code" as const, model: "m" },
      verdicts: [
        { id: "A1", passed: true, observation: "ok", evidence: [] },
        { id: "A2", passed: false, observation: "the button does nothing", evidence: ["tester/A2.png"] },
      ],
    };

    expect(runCauses(entryOf({ result: "draft", verification: verification({ criteria: [criterion("A2", true)], tester }) }), NOW)).toEqual([
      {
        kind: "failed-verdict",
        where: "Acceptance tester · A2",
        what: "falla",
        detail: "the button does nothing",
        evidence: { tab: "verification", anchor: "tester-verdict-A2" },
        next: REVIEW_SPEC,
      },
    ]);
  });

  it("should start a new run for an error of the acceptance tester, which is not a fault of the code", () => {
    const tester = { agent: { agent: "claude-code" as const, model: "m" }, verdicts: [], error: "the report was not valid JSON" };

    expect(runCauses(entryOf({ result: "draft", verification: verification({ tester }) }), NOW)).toEqual([
      {
        kind: "tester-error",
        where: "Acceptance tester",
        what: "error",
        detail: "the report was not valid JSON",
        evidence: { tab: "verification", anchor: "tester" },
        next: NEW_RUN,
      },
    ]);
  });

  it("should start a new run for an environment problem that kept the integrated verification from running", () => {
    expect(runCauses(entryOf({ result: "draft", verification: verification({ environment: "the app did not start in 60 s" }) }), NOW)).toEqual([
      {
        kind: "environment",
        where: "Integrated verification",
        what: "no se pudo ejecutar",
        detail: "the app did not start in 60 s",
        evidence: { tab: "verification", anchor: "verification" },
        next: NEW_RUN,
      },
    ]);
  });

  it("should list the human criteria of a draft with no other cause, with no command, since a person checks them in the pull request", () => {
    const log = { result: "draft" as const, verification: verification({ passed: true, humanCriteria: [{ id: "H1", reason: "layout", attachments: [] }, { id: "H2", reason: "copy", attachments: [] }] }) };

    expect(runCauses(entryOf(log), NOW)).toEqual([
      {
        kind: "human-criteria",
        where: "Criterios human",
        what: "H1, H2",
        detail: null,
        evidence: { tab: "verification", anchor: "human-criteria" },
        next: null,
      },
    ]);
  });

  it("should not list the human criteria when another cause explains the draft", () => {
    const log = {
      result: "draft" as const,
      verification: verification({ checks: [failedCheck("test", "x")], humanCriteria: [{ id: "H1", reason: "layout", attachments: [] }] }),
    };

    expect(runCauses(entryOf(log), NOW).map((cause) => cause.kind)).toEqual(["failed-check"]);
  });

  it("should give no command for a conflict with the default branch, because only a change by hand or of the spec solves it", () => {
    const block = { type: "default-branch-conflict" as const, reason: "main changed src/a.ts", sha: "abc", files: ["src/a.ts"] };

    expect(runCauses(entryOf({ result: "draft", block }), NOW).map((cause) => cause.next)).toEqual([REVIEW_SPEC]);
  });
});
