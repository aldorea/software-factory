import { describe, expect, it } from "vitest";
import {
  firstErrorLine,
  gateFailure,
  outcomeFailure,
  outputSection,
  outputTail,
  TAIL_BYTES,
  TAIL_LINES,
} from "../../src/coordinator/failures.ts";
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

describe("outputTail", () => {
  it("should keep only the last 40 lines, because the cause of a failure is usually at the end of its output", () => {
    const output = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");

    const tail = outputTail(output)?.split("\n") ?? [];

    expect(TAIL_LINES).toBe(40);
    expect(tail).toHaveLength(40);
    expect(tail[0]).toBe("line 61");
    expect(tail.at(-1)).toBe("line 100");
  });

  it("should remove the colors and the empty lines at both ends", () => {
    expect(outputTail("\n\n\u001b[31mError: boom\u001b[0m   \n\n  at a.ts:1\n\n\n")).toBe("Error: boom\n\n  at a.ts:1");
  });

  it("should keep at most 4 KB, dropping whole lines from the start", () => {
    const output = Array.from({ length: 30 }, (_, index) => `${index + 1} ${"é".repeat(200)}`).join("\n");

    const tail = outputTail(output) ?? "";

    expect(TAIL_BYTES).toBe(4096);
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(4096);
    expect(tail.split("\n").every((line) => /^\d+ é{200}$/.test(line))).toBe(true);
    expect(tail.endsWith(`30 ${"é".repeat(200)}`)).toBe(true);
  });

  it("should keep the end of a single line longer than 4 KB without a broken character", () => {
    const tail = outputTail(`start ${"é".repeat(5000)} end`) ?? "";

    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(4096);
    expect(tail.endsWith(" end")).toBe(true);
    expect(tail).not.toContain("\uFFFD");
  });

  it("should give nothing for an output with no text", () => {
    expect(outputTail("\u001b[0m\n  \n")).toBeUndefined();
  });
});

describe("outputSection", () => {
  it("should fence the tail with more backticks than it holds, so a fence in the output cannot close it", () => {
    const section = outputSection("check lint", "before\n````\nafter");

    expect(section).toContain("The last lines of the output of check lint:");
    expect(section).toContain("`````text\nbefore\n````\nafter\n`````");
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
    expect(failure.output).toBeUndefined();
  });

  it("should carry the output of each rejection apart from its description, so the last failure of a block stays one line", () => {
    const failure = gateFailure({
      ...decision,
      rejections: [
        { kind: "check", message: "check lint failed with exit code 1", signature: "check:lint", output: "lint output" },
        { kind: "criterion", message: "criterion A1 (request) failed with exit code 1", signature: "criterion:A1", output: "A1 output" },
      ],
    });

    expect(failure.output).toBe("lint output\n\nA1 output");
    expect(failure.description).not.toContain("lint output");
  });
});
