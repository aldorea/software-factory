import { describe, expect, it } from "vitest";
import { answerFrom, dockerVerifier } from "../../src/coordinator/docker-verifier.ts";

describe("answerFrom the outcome of the verifier agent", () => {
  it("should accept when the answer starts with ACCEPT", () => {
    expect(answerFrom({ kind: "completed", summary: "ACCEPT\nThe test asserts the text." })).toEqual({ kind: "accept" });
  });

  it("should refute with the reason that follows REFUTE, on the same line or after it", () => {
    expect(answerFrom({ kind: "completed", summary: "REFUTE: asserts nothing" })).toEqual({
      kind: "refute",
      reason: "asserts nothing",
    });
    expect(answerFrom({ kind: "completed", summary: "REFUTE\nIt never checks the text.\nIt is skipped." })).toEqual({
      kind: "refute",
      reason: "It never checks the text.\nIt is skipped.",
    });
  });

  it("should still refute when REFUTE comes with no reason, because the gate must not accept it", () => {
    expect(answerFrom({ kind: "completed", summary: "REFUTE" })).toEqual({ kind: "refute", reason: "the verifier gave no reason" });
  });

  it("should error on an empty answer", () => {
    expect(answerFrom({ kind: "completed", summary: "  \n" })).toEqual({ kind: "error", message: "the verifier gave no answer" });
  });

  it("should error on an answer that is neither ACCEPT nor REFUTE, because an unclear answer cannot accept a test", () => {
    expect(answerFrom({ kind: "completed", summary: "The test looks fine to me." })).toMatchObject({ kind: "error" });
    expect(answerFrom({ kind: "completed", summary: "ACCEPTABLE" })).toMatchObject({ kind: "error" });
  });

  it("should error on an agent error, which is how the worker layer reports a tool use", () => {
    expect(
      answerFrom({ kind: "agent-error", message: "The verifier changed its directory despite the deny-all config: probe.txt", exitCode: 0 }),
    ).toEqual({ kind: "error", message: "The verifier changed its directory despite the deny-all config: probe.txt" });
  });

  it("should error when the verifier hits a deadline or an idle timeout", () => {
    expect(answerFrom({ kind: "deadline" })).toMatchObject({ kind: "error" });
    expect(answerFrom({ kind: "idle-timeout" })).toMatchObject({ kind: "error" });
  });

  it("should report a plan limit with its reset time, because a plan limit of any agent pauses the run", () => {
    const resetsAt = new Date("2026-10-24T13:00:00.000Z");
    expect(answerFrom({ kind: "plan-limit", message: "limit", resetsAt })).toEqual({ kind: "plan-limit", message: "limit", resetsAt });
  });
});

describe("dockerVerifier", () => {
  it("should refuse an agent that cannot deny every tool, before any container starts", () => {
    expect(() =>
      dockerVerifier({ image: "x", role: { agent: "claude-code", model: "sonnet" }, env: {}, idleTimeoutMs: 1000 }),
    ).toThrow("claude-code cannot serve the verifier");
  });
});
