import { afterEach, describe, expect, it } from "vitest";
import type { GateRecord } from "../../src/coordinator/run-log.ts";
import { attemptRecord, subtaskRecord } from "../coordinator/run-log-fixtures.ts";
import { aRun, runPage, temp, visibleText } from "./run-page-helpers.ts";

afterEach(() => temp.removeAll());

describe("the subtasks of a run", () => {
  it("should show each subtask with its state, criteria, branch and scope extensions", async () => {
    const log = aRun(0, {
      subtasks: [
        subtaskRecord("S1", { state: "merged", criteria: ["C1", "C2"], branch: "factory-subtask/1-x/S1", scopeExtensions: ["src/extra.ts"] }),
        subtaskRecord("S2", { state: "working", criteria: ["C3"], branch: "factory-subtask/1-x/S2" }),
      ],
    });

    const text = visibleText(await runPage(log));

    expect(text).toContain("S1");
    expect(text).toContain("Estado: merged");
    expect(text).toContain("Criterios: C1, C2");
    expect(text).toContain("Branch: factory-subtask/1-x/S1");
    expect(text).toContain("Scope extensions: src/extra.ts");
    expect(text).toContain("S2");
    expect(text).toContain("Estado: working");
    expect(text).toContain("Branch: factory-subtask/1-x/S2");
  });

  it("should escape the text that a subtask brings from run.json", async () => {
    const log = aRun(0, { subtasks: [subtaskRecord("<b>S1</b>", { criteria: ["<script>x</script>"] })] });

    const body = await runPage(log);

    expect(body).not.toContain("<script>x</script>");
    expect(body).not.toContain("<b>S1</b>");
  });

  it("should show each attempt with its agent, outcome, failure, tokens and hours", async () => {
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

    const text = visibleText(await runPage(log));

    expect(text).toContain("Intento 2");
    expect(text).toContain("opencode / opencode-go/kimi-k2");
    expect(text).toContain("Resultado: agent-error");
    expect(text).toContain("Fallo: typecheck failed in src/a.ts");
    expect(text).toContain("Tokens: 1250");
    expect(text).toContain("2026-10-24T08:00:00.000Z");
    expect(text).toContain("2026-10-24T08:12:00.000Z");
  });

  it("should leave out the failure of an attempt that has none", async () => {
    const log = aRun(0, { subtasks: [subtaskRecord("S1", { attempts: [attemptRecord("claude-code", 10, 5)] })] });

    const text = visibleText(await runPage(log));

    expect(text).toContain("Intento 1");
    expect(text).not.toContain("Fallo:");
  });

  it("should show the gate of a subtask with its checks, criteria and independent verifier verdicts", async () => {
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

    const text = visibleText(await runPage(log));

    expect(text).toContain("Gate abc1234: rechazado");
    expect(text).toContain("the independent verifier refuted C2");
    expect(text).toContain("typecheck: pasa");
    expect(text).toContain("test: falla");
    expect(text).toContain("1 test failed");
    expect(text).toContain("C1: pasa");
    expect(text).toContain("C1: accept");
    expect(text).toContain("C2: refute");
    expect(text).toContain("the button is missing");
    expect(text).toContain("2 rechazos del gate");
    expect(text).toContain("1 rechazos del independent verifier");
  });

  it("should show a gate that accepted", async () => {
    const gate: GateRecord = { sha: "def5678", accepted: true, reasons: [], checks: [], criteria: [], verifier: [] };
    const log = aRun(0, { subtasks: [subtaskRecord("S1", { gate })] });

    const text = visibleText(await runPage(log));

    expect(text).toContain("Gate def5678: aceptado");
  });

  it("should show the gate rejections even when the subtask has no gate yet", async () => {
    const log = aRun(0, { subtasks: [subtaskRecord("S1", { state: "working", gateRejections: 3 })] });

    const text = visibleText(await runPage(log));

    expect(text).toContain("3 rechazos del gate");
    expect(text).not.toContain("Gate ");
  });

  it("should show the type, the reason and the last failure of a blocked subtask", async () => {
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

    const text = visibleText(await runPage(log));

    expect(text).toContain("Bloqueo: patience");
    expect(text).toContain("Motivo: five attempts without progress");
    expect(text).toContain("Último fallo: typecheck failed in src/a.ts");
  });

  it("should show the reason of a blocked subtask that has no last failure", async () => {
    const log = aRun(0, {
      subtasks: [subtaskRecord("S1", { state: "blocked", blockType: "scope", reason: "it needs src/other.ts" })],
    });

    const text = visibleText(await runPage(log));

    expect(text).toContain("Bloqueo: scope");
    expect(text).toContain("Motivo: it needs src/other.ts");
    expect(text).not.toContain("Último fallo:");
  });

  it("should not show a block for a subtask that is not blocked", async () => {
    const text = visibleText(await runPage(aRun(0, { subtasks: [subtaskRecord("S1", { state: "merged" })] })));

    expect(text).not.toContain("Bloqueo:");
  });

  it("should show each follow-up task of a subtask with its round, criteria, failure and outcome", async () => {
    const log = aRun(0, {
      subtasks: [
        subtaskRecord("S1", {
          followUps: [
            { round: 1, criteria: ["C1", "C2"], failure: "the tester refuted C1", outcome: "merged" },
            { round: 2, criteria: ["C3"], failure: "the tester refuted C3", outcome: "blocked" },
          ],
        }),
      ],
    });

    const text = visibleText(await runPage(log));

    expect(text).toContain("Follow-up ronda 1");
    expect(text).toContain("Criterios: C1, C2");
    expect(text).toContain("Fallo: the tester refuted C1");
    expect(text).toContain("Resultado: merged");
    expect(text).toContain("Follow-up ronda 2");
    expect(text).toContain("Resultado: blocked");
  });

  it("should say that a run has no subtasks yet when it has none", async () => {
    const text = visibleText(await runPage(aRun(0, { subtasks: [] })));

    expect(text).toContain("Subtareas");
    expect(text).toContain("Sin subtareas");
  });
});
