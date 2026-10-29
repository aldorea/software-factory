import { describe, expect, it } from "vitest";
import { toEnvFile } from "../../src/workers/docker-runner.ts";
import { applyOpenCodeLine, initialOpenCodeState } from "../../src/workers/opencode.ts";
import type { SupervisedProcess } from "../../src/workers/supervise.ts";
import { verifierActivity, verifierOutcome } from "../../src/workers/verifier.ts";

const exited: SupervisedProcess = { stopReason: "exited", exitCode: 0, stderrTail: "" };

const answer = (text: string) =>
  applyOpenCodeLine(initialOpenCodeState(), JSON.stringify({ type: "text", part: { type: "text", text } }));

describe("Verifier outcome", () => {
  it("should accept an answer when only the config is in its directory", () => {
    expect(verifierOutcome(answer("OK"), exited, "opencode.jsonc\n")).toEqual({ kind: "completed", summary: "OK" });
  });

  it("should reject an answer when the verifier left a file in its directory, because a tool escaped the config", () => {
    expect(verifierOutcome(answer("OK"), exited, "opencode.jsonc\nprobe.txt\n")).toEqual({
      kind: "agent-error",
      message: "The verifier changed its directory despite the deny-all config: probe.txt",
      exitCode: 0,
    });
  });

  it("should treat an empty answer as an agent error, so silence never passes a criterion", () => {
    expect(verifierOutcome(answer("  "), exited, "opencode.jsonc\n")).toEqual({
      kind: "agent-error",
      message: "The verifier gave no answer",
      exitCode: 0,
    });
  });

  it("should keep the agent error of OpenCode", () => {
    const outcome = verifierOutcome(initialOpenCodeState(), { ...exited, exitCode: 1, stderrTail: "bad" }, "");
    expect(outcome).toEqual({ kind: "agent-error", message: "bad", exitCode: 1 });
  });
});

describe("Env file", () => {
  it("should write one variable per line", () => {
    expect(toEnvFile({ A: "1", B: "two" })).toBe("A=1\nB=two");
  });

  it("should refuse a value with a newline, so a secret cannot inject another variable", () => {
    expect(() => toEnvFile({ TOKEN: "abc\nGH_TOKEN=x" })).toThrow(/TOKEN has a newline/);
  });
});

describe("OpenCode verifier activity", () => {
  it("should end with an end event when the verifier outcome is known, because the OpenCode stream has no end line of its own", () => {
    expect(verifierActivity("opencode").finish({ kind: "completed", summary: "OK" })).toEqual([{ kind: "end", outcome: "completed" }]);
    expect(verifierActivity("opencode").finish({ kind: "agent-error", message: "no answer", exitCode: 0 })).toEqual([
      { kind: "end", outcome: "failed" },
    ]);
  });
});
