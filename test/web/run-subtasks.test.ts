import { afterEach, describe, expect, it } from "vitest";
import type { GateRecord } from "../../src/coordinator/run-log.ts";
import { attemptRecord, subtaskRecord } from "../coordinator/run-log-fixtures.ts";
import { aRun, runDetail, temp } from "./web-helpers.ts";

afterEach(() => temp.removeAll());

describe("the subtasks of a run", () => {
  it("should give each subtask with its state, criteria, branch and scope extensions", async () => {
    const log = aRun(0, {
      subtasks: [
        subtaskRecord("S1", { state: "merged", criteria: ["C1", "C2"], branch: "factory-subtask/1-x/S1", scopeExtensions: ["src/extra.ts"] }),
        subtaskRecord("S2", { state: "working", criteria: ["C3"], branch: "factory-subtask/1-x/S2" }),
      ],
    });

    const { subtasks } = await runDetail(log);

    expect(subtasks.map(({ id, state, criteria, branch, scopeExtensions }) => ({ id, state, criteria, branch, scopeExtensions }))).toEqual([
      { id: "S1", state: "merged", criteria: ["C1", "C2"], branch: "factory-subtask/1-x/S1", scopeExtensions: ["src/extra.ts"] },
      { id: "S2", state: "working", criteria: ["C3"], branch: "factory-subtask/1-x/S2", scopeExtensions: [] },
    ]);
  });

  it("should give each attempt with its agent, outcome, failure, counted tokens and hours", async () => {
    const attempt = {
      ...attemptRecord("opencode", 1000, 250),
      number: 2,
      agent: { agent: "opencode" as const, model: "opencode-go/kimi-k2" },
      outcome: "agent-error" as const,
      failure: { signature: "sig-1", description: "typecheck failed in src/a.ts" },
      startedAt: "2026-10-24T08:00:00.000Z",
      endedAt: "2026-10-24T08:12:00.000Z",
    };
    const log = aRun(0, { subtasks: [subtaskRecord("S1", { attempts: [attempt] })] });

    const [subtask] = (await runDetail(log)).subtasks;

    expect(subtask?.attempts).toEqual([
      {
        number: 2,
        agent: "opencode",
        model: "opencode-go/kimi-k2",
        outcome: "agent-error",
        succeeded: false,
        detail: null,
        failure: "typecheck failed in src/a.ts",
        tokens: 1250,
        startedAt: "2026-10-24T08:00:00.000Z",
        endedAt: "2026-10-24T08:12:00.000Z",
        logUrl: null,
      },
    ]);
  });

  it("should say whether each attempt succeeded, and nothing yet for an attempt in progress", async () => {
    const attempts = [
      { ...attemptRecord("claude-code", 10, 5), number: 1, outcome: "completed" as const },
      { ...attemptRecord("claude-code", 10, 5), number: 2, outcome: "running" as const },
    ];
    const log = aRun(0, { result: "running", subtasks: [subtaskRecord("S1", { attempts })] });

    expect((await runDetail(log)).subtasks[0]?.attempts.map((attempt) => [attempt.outcome, attempt.succeeded])).toEqual([
      ["completed", true],
      ["running", null],
    ]);
  });

  it("should give no failure for an attempt that has none", async () => {
    const log = aRun(0, { subtasks: [subtaskRecord("S1", { attempts: [attemptRecord("claude-code", 10, 5)] })] });

    expect((await runDetail(log)).subtasks[0]?.attempts[0]?.failure).toBeNull();
  });

  it("should give the gate of a subtask with its reasons, checks, criteria and independent verifier verdicts, and the rejections", async () => {
    const gate: GateRecord = {
      sha: "abc1234",
      accepted: false,
      reasons: ["the independent verifier refuted C2"],
      checks: [
        { name: "typecheck", command: "pnpm typecheck", exitCode: 0, passed: true },
        { name: "test", command: "pnpm test", exitCode: 1, passed: false, firstError: "1 test failed" },
      ],
      criteria: [{ id: "C1", evidence: "request", command: "curl x", exitCode: 0, passed: true }],
      verifier: [
        { id: "C1", verdict: "accept", logPath: "/logs/v1.jsonl" },
        { id: "C2", verdict: "refute", reason: "the button is missing", logPath: "/logs/v2.jsonl" },
      ],
    };
    const log = aRun(0, { subtasks: [subtaskRecord("S1", { gate, gateRejections: 2, verifierRejections: 1 })] });

    const [subtask] = (await runDetail(log)).subtasks;

    expect(subtask?.gate).toEqual({
      sha: "abc1234",
      accepted: false,
      reasons: ["the independent verifier refuted C2"],
      checks: [
        { name: "typecheck", passed: true, firstError: null, outputUrl: null },
        { name: "test", passed: false, firstError: "1 test failed", outputUrl: null },
      ],
      criteria: [{ id: "C1", passed: true, outputUrl: null }],
      verifier: [
        { id: "C1", verdict: "accept", accepted: true, reason: null, logUrl: null },
        { id: "C2", verdict: "refute", accepted: false, reason: "the button is missing", logUrl: null },
      ],
    });
    expect([subtask?.gateRejections, subtask?.verifierRejections]).toEqual([2, 1]);
  });

  it("should give the gate rejections even when the subtask has no gate yet", async () => {
    const log = aRun(0, { subtasks: [subtaskRecord("S1", { state: "working", gateRejections: 3 })] });

    const [subtask] = (await runDetail(log)).subtasks;

    expect(subtask?.gateRejections).toBe(3);
    expect(subtask?.gate).toBeNull();
  });

  it("should give the type, the reason and the last failure of a blocked subtask", async () => {
    const log = aRun(0, {
      subtasks: [
        subtaskRecord("S1", {
          state: "blocked",
          blockType: "patience",
          reason: "five attempts without progress",
          block: { type: "patience", reason: "five attempts without progress", lastFailure: "typecheck failed in src/a.ts" },
        }),
      ],
    });

    expect((await runDetail(log)).subtasks[0]?.block).toEqual({
      type: "patience",
      reason: "five attempts without progress",
      lastFailure: "typecheck failed in src/a.ts",
    });
  });

  it("should take the type and the reason of a blocked subtask from its block when run.json keeps them only there", async () => {
    const log = aRun(0, {
      subtasks: [subtaskRecord("S1", { state: "blocked", block: { type: "scope", reason: "it needs src/other.ts" } })],
    });

    expect((await runDetail(log)).subtasks[0]?.block).toEqual({ type: "scope", reason: "it needs src/other.ts", lastFailure: null });
  });

  it("should give no block for a subtask that is not blocked", async () => {
    const log = aRun(0, { subtasks: [subtaskRecord("S1", { state: "merged", reason: "an old reason" })] });

    expect((await runDetail(log)).subtasks[0]?.block).toBeNull();
  });

  it("should give each follow-up task of a subtask with its round, criteria, failure and outcome", async () => {
    const followUps = [
      { round: 1, criteria: ["C1", "C2"], failure: "the tester refuted C1", outcome: "merged" as const },
      { round: 2, criteria: ["C3"], failure: "the tester refuted C3", outcome: "blocked" as const },
    ];
    const log = aRun(0, { subtasks: [subtaskRecord("S1", { followUps })] });

    expect((await runDetail(log)).subtasks[0]?.followUps).toEqual(followUps);
  });

  it("should give an empty list for a run with no subtasks yet", async () => {
    expect((await runDetail(aRun(0, { subtasks: [] }))).subtasks).toEqual([]);
  });
});
