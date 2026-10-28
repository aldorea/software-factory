import { describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../../src/config/config.ts";
import { answerFrom, configuredVerifier } from "../../src/coordinator/docker-verifier.ts";
import { FakeClock } from "../fakes/clock.ts";

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

describe("configuredVerifier", () => {
  it("should name the missing credential of the verifier, never fail with an empty message", async () => {
    const config = resolved();
    const verifier = configuredVerifier(config, { agent: "opencode", model: "opencode-go/kimi-k2" }, {}, clock);

    await expect(verifier.judge({ id: "A1", criterion: "c", test: "t", logPath: "/dev/null" })).rejects.toThrow(
      "OPENCODE_API_KEY is not set; the opencode verifier needs it",
    );
  });
});

const clock = new FakeClock("2026-10-24T08:00:00.000Z");

function resolved(): ResolvedConfig {
  const result = resolveConfig({ image: "x", checks: [{ name: "c", command: "true" }], environment: () => ({}), protectedPaths: [] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.config;
}
