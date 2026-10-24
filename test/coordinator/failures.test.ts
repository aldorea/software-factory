import { describe, expect, it } from "vitest";
import { firstErrorLine, gateFailure, outcomeFailure } from "../../src/coordinator/failures.ts";
import type { GateDecision } from "../../src/coordinator/gate.ts";

describe("outcomeFailure", () => {
  it("should not count a completed attempt or a plan limit as a failure, because the pause spends no patience", () => {
    expect(outcomeFailure({ kind: "completed", summary: "done" })).toBeNull();
    expect(outcomeFailure({ kind: "plan-limit", message: "5-hour limit" })).toBeNull();
  });

  it("should give the deadline and the idle timeout each its own signature", () => {
    const deadline = outcomeFailure({ kind: "deadline" });
    const idle = outcomeFailure({ kind: "idle-timeout" });

    expect(deadline?.signature).toBe("deadline");
    expect(idle?.signature).toBe("idle-timeout");
    expect(deadline?.description).not.toBe(idle?.description);
  });

  it("should sign an agent error by the first line of its message, whatever the exit code", () => {
    const first = outcomeFailure({ kind: "agent-error", message: "spawn failed\nstack line", exitCode: 1 });
    const again = outcomeFailure({ kind: "agent-error", message: "spawn failed", exitCode: 137 });
    const other = outcomeFailure({ kind: "agent-error", message: "network down", exitCode: 1 });

    expect(first?.signature).toBe("agent-error: spawn failed");
    expect(again?.signature).toBe(first?.signature);
    expect(other?.signature).not.toBe(first?.signature);
    expect(first?.description).toContain("spawn failed");
  });

  it("should sign an agent error with no message by its kind alone", () => {
    expect(outcomeFailure({ kind: "agent-error", message: "", exitCode: null })?.signature).toBe("agent-error");
  });
});

describe("firstErrorLine", () => {
  it("should pick the first line that names an error or a failure, without colors", () => {
    const output = "\u001b[1mRunning\u001b[0m\n\n  \u001b[31mFAIL\u001b[0m src/a.test.ts > adds\nAssertionError: expected 1 to be 2\n";

    expect(firstErrorLine(output)).toBe("FAIL src/a.test.ts > adds");
  });

  it("should fall back to the first non-empty line when no line names an error", () => {
    expect(firstErrorLine("\n  something odd\nsecond\n")).toBe("something odd");
  });

  it("should give nothing for an empty output", () => {
    expect(firstErrorLine("  \n\n")).toBeUndefined();
  });

  it("should cut a very long line", () => {
    expect(firstErrorLine(`error ${"x".repeat(500)}`)?.length).toBe(200);
  });
});

describe("gateFailure", () => {
  const decision: GateDecision = {
    accepted: false,
    reasons: ["it touches protected paths: package.json", "check lint failed with exit code 1"],
    rejections: [
      { kind: "protected", message: "it touches protected paths: package.json", signature: "protected:package.json" },
      { kind: "check", message: "check lint failed with exit code 1", signature: "check:lint" },
    ],
    signature: "protected:package.json | check:lint",
  };

  it("should carry the signature of the decision and every reason in its description", () => {
    const failure = gateFailure(decision);

    expect(failure.signature).toBe("protected:package.json | check:lint");
    expect(failure.description).toContain("it touches protected paths: package.json");
    expect(failure.description).toContain("check lint failed with exit code 1");
  });
});
