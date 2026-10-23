import { describe, expect, it } from "vitest";
import { applyOpenCodeLine, initialOpenCodeState, openCodeArgs, openCodeOutcome } from "../../src/workers/opencode.ts";

describe("OpenCode", () => {
  it("refuses a model outside the subscription provider", () => {
    expect(() => openCodeArgs("hi", "opencode/big-pickle")).toThrow(/opencode-go/);
    expect(openCodeArgs("hi", "opencode-go/glm-5.3")).toContain("opencode-go/glm-5.3");
  });

  it("keeps the last text part", () => {
    const line = JSON.stringify({ type: "text", part: { type: "text", text: "OK" } });
    const state = applyOpenCodeLine(initialOpenCodeState(), line);
    expect(openCodeOutcome(state, { stopReason: "exited", exitCode: 0, stderrTail: "" })).toEqual({
      kind: "completed",
      summary: "OK",
    });
  });

  it("reports a non-zero exit as an agent error", () => {
    const outcome = openCodeOutcome(initialOpenCodeState(), { stopReason: "exited", exitCode: 2, stderrTail: "bad" });
    expect(outcome).toEqual({ kind: "agent-error", message: "bad", exitCode: 2 });
  });
});
