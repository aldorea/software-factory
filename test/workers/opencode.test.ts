import { describe, expect, it } from "vitest";
import { applyOpenCodeLine, initialOpenCodeState, openCodeArgs, openCodeOutcome } from "../../src/workers/opencode.ts";

describe("OpenCode", () => {
  it("refuses a model outside the subscription provider", () => {
    expect(() => openCodeArgs("opencode/big-pickle")).toThrow(/opencode-go/);
    expect(openCodeArgs("opencode-go/glm-5.3")).toContain("opencode-go/glm-5.3");
  });

  it("refuses a Claude model, even through the subscription provider", () => {
    expect(() => openCodeArgs("opencode-go/claude-haiku-5-5")).toThrow(/Claude/);
  });

  it("leaves out the auto approval when asked", () => {
    expect(openCodeArgs("opencode-go/glm-5.3", { autoApprove: false })).not.toContain("--auto");
  });

  it("selects the given agent", () => {
    expect(openCodeArgs("opencode-go/glm-5.3", { autoApprove: false, agent: "verifier" })).toEqual([
      "opencode",
      "run",
      "--standalone",
      "--format",
      "json",
      "--agent",
      "verifier",
      "-m",
      "opencode-go/glm-5.3",
    ]);
  });

  it("runs a private server, so the key in its environment reaches the provider", () => {
    expect(openCodeArgs("opencode-go/glm-5.3").slice(0, 3)).toEqual(["opencode", "run", "--standalone"]);
  });

  it("takes the prompt from stdin, not from the arguments", () => {
    expect(openCodeArgs("opencode-go/glm-5.3")).toEqual([
      "opencode",
      "run",
      "--standalone",
      "--format",
      "json",
      "--auto",
      "-m",
      "opencode-go/glm-5.3",
    ]);
  });

  it("keeps the last text part", () => {
    const line = JSON.stringify({ type: "text", part: { type: "text", text: "OK" } });
    const state = applyOpenCodeLine(initialOpenCodeState(), line);
    expect(openCodeOutcome(state, { stopReason: "exited", exitCode: 0, stderrTail: "" })).toEqual({
      kind: "completed",
      summary: "OK",
    });
  });

  it("reports an error event on stdout as an agent error, even with exit code 0", () => {
    const line = JSON.stringify({
      type: "error",
      error: { type: "provider.no-route", message: "Model unavailable: opencode-go/beam-free" },
    });
    const state = applyOpenCodeLine(initialOpenCodeState(), line);
    expect(openCodeOutcome(state, { stopReason: "exited", exitCode: 0, stderrTail: "" })).toEqual({
      kind: "agent-error",
      message: "provider.no-route: Model unavailable: opencode-go/beam-free",
      exitCode: 0,
    });
  });

  it("reports a non-zero exit as an agent error", () => {
    const outcome = openCodeOutcome(initialOpenCodeState(), { stopReason: "exited", exitCode: 2, stderrTail: "bad" });
    expect(outcome).toEqual({ kind: "agent-error", message: "bad", exitCode: 2 });
  });
});
