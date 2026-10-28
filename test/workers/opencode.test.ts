import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyOpenCodeLine,
  initialOpenCodeState,
  openCodeArgs,
  openCodeExportArgs,
  openCodeOutcome,
  parseOpenCodeExport,
} from "../../src/workers/opencode.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const realRun = fixture("opencode-run.jsonl").trim().split("\n");
const realExport = fixture("opencode-export.json");

describe("OpenCode", () => {
  it("should refuse a model outside the subscription provider", () => {
    expect(() => openCodeArgs("opencode/big-pickle")).toThrow(/opencode-go/);
    expect(openCodeArgs("opencode-go/glm-5.3")).toContain("opencode-go/glm-5.3");
  });

  it("should refuse a Claude model, even through the subscription provider", () => {
    expect(() => openCodeArgs("opencode-go/claude-haiku-5-5")).toThrow(/Claude/);
  });

  it("should leave out the auto approval when asked", () => {
    expect(openCodeArgs("opencode-go/glm-5.3", { autoApprove: false })).not.toContain("--auto");
  });

  it("should select the given agent", () => {
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

  it("should run a private server, so the key in its environment reaches the provider", () => {
    expect(openCodeArgs("opencode-go/glm-5.3").slice(0, 3)).toEqual(["opencode", "run", "--standalone"]);
  });

  it("should take the prompt from stdin, not from the arguments", () => {
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

  it("should keep the last text part", () => {
    const line = JSON.stringify({ type: "text", part: { type: "text", text: "OK" } });
    const state = applyOpenCodeLine(initialOpenCodeState(), line);
    expect(openCodeOutcome(state, { stopReason: "exited", exitCode: 0, stderrTail: "" })).toEqual({
      kind: "completed",
      summary: "OK",
    });
  });

  it("should report an error event on stdout as an agent error, even with exit code 0", () => {
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

  it("should report the Go usage limit as a plan limit that resets after its retry-after, with the event shape of the OpenCode repo's own tests until a run captures a real one", () => {
    const state = applyOpenCodeLine(initialOpenCodeState(), fixture("opencode-go-limit.jsonl").trim());

    expect(openCodeOutcome(state, { stopReason: "exited", exitCode: 1, stderrTail: "" })).toEqual({
      kind: "plan-limit",
      message: "provider.quota: Subscription quota exceeded.",
      resetsAt: new Date(1792918729286 + 120000),
    });
  });

  it("should report the Go usage limit as a plan limit with no reset time when no retry-after comes", () => {
    const line = JSON.stringify({
      type: "error",
      timestamp: 1792918729286,
      error: { type: "provider.unknown", message: "Go usage limit exceeded", status: 429, response: { body: '{"error":{"type":"GoUsageLimitError"}}' } },
    });
    const state = applyOpenCodeLine(initialOpenCodeState(), line);

    expect(openCodeOutcome(state, { stopReason: "exited", exitCode: 1, stderrTail: "" })).toEqual({
      kind: "plan-limit",
      message: "provider.unknown: Go usage limit exceeded",
    });
  });

  it("should report a non-zero exit as an agent error", () => {
    const outcome = openCodeOutcome(initialOpenCodeState(), { stopReason: "exited", exitCode: 2, stderrTail: "bad" });
    expect(outcome).toEqual({ kind: "agent-error", message: "bad", exitCode: 2 });
  });

  it("should keep the session id that every line of a real stream carries", () => {
    const state = realRun.reduce(applyOpenCodeLine, initialOpenCodeState());
    expect(state.sessionId).toBe("ses_e8db759a3ffezu7WMaX4o4J11V");
    expect(state.lastText).toBe("OK");
  });

  it("should have no session id before the stream carries one", () => {
    expect(initialOpenCodeState().sessionId).toBeUndefined();
    expect(applyOpenCodeLine(initialOpenCodeState(), "not json").sessionId).toBeUndefined();
  });

  it("should export a session with the private server, so it reads the sessions of the run", () => {
    expect(openCodeExportArgs("ses_abc")).toEqual(["opencode", "session", "export", "--standalone", "ses_abc"]);
  });
});

describe("OpenCode export", () => {
  it("should read the token usage of a real export, with the cache write as the cache creation", () => {
    expect(parseOpenCodeExport(realExport)).toEqual({
      ok: true,
      usage: { inputTokens: 11138, cacheCreationInputTokens: 0, cacheReadInputTokens: 1356, outputTokens: 10 },
    });
  });

  it("should count the reasoning tokens as output, because the plan bills them as such", () => {
    const withReasoning = withTokens({ input: 100, output: 20, reasoning: 7, cache: { read: 3, write: 5 } });
    expect(parseOpenCodeExport(withReasoning)).toEqual({
      ok: true,
      usage: { inputTokens: 100, cacheCreationInputTokens: 5, cacheReadInputTokens: 3, outputTokens: 27 },
    });
  });

  it("should report an export that is not JSON as unreadable, not throw", () => {
    expect(parseOpenCodeExport("Error: session not found")).toMatchObject({ ok: false });
  });

  it("should report an export with no token counts as unreadable, so a zero never hides a missing number", () => {
    expect(parseOpenCodeExport(JSON.stringify({ info: { cost: 1 } }))).toMatchObject({ ok: false });
    expect(parseOpenCodeExport(withTokens({ input: 1, output: "x", reasoning: 0, cache: { read: 0, write: 0 } }))).toMatchObject({
      ok: false,
    });
    expect(parseOpenCodeExport(withTokens({ input: 1, output: 1, reasoning: 0 }))).toMatchObject({ ok: false });
  });
});

function withTokens(tokens: unknown): string {
  const data = JSON.parse(realExport) as { info: Record<string, unknown> };
  data.info.tokens = tokens;
  return JSON.stringify(data);
}
