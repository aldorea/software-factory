import { describe, expect, it } from "vitest";
import { adapterFor, AGENT_KINDS, agentsForRole, meetsRole, missingRequirements } from "../../src/workers/agents.ts";
import type { AgentAdapter } from "../../src/workers/agent-adapter.ts";
import type { SupervisedProcess } from "../../src/workers/supervise.ts";

const exited: SupervisedProcess = { stopReason: "exited", exitCode: 0, stderrTail: "" };

const claudeResult = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "OK",
  api_error_status: null,
  usage: { input_tokens: 2, cache_creation_input_tokens: 17023, cache_read_input_tokens: 11803, output_tokens: 4 },
});

const claudeRejected = JSON.stringify({
  type: "rate_limit_event",
  rate_limit_info: { status: "rejected", resetsAt: 1792792800, rateLimitType: "seven_day", unifiedWindows: {} },
});

const openCodeText = JSON.stringify({ type: "text", part: { type: "text", text: "OK" } });

function run(adapter: AgentAdapter, lines: string[]) {
  const stream = adapter.createStream();
  for (const line of lines) stream.onLine(line);
  return stream;
}

describe("agent adapters", () => {
  it("should have one adapter for each agent kind", () => {
    for (const kind of AGENT_KINDS) expect(adapterFor(kind).kind).toBe(kind);
  });

  it("should build the Claude Code command with the model", () => {
    expect(adapterFor("claude-code").command("claude-haiku-5-5")).toContain("claude-haiku-5-5");
    expect(adapterFor("claude-code").command("claude-haiku-5-5")[0]).toBe("claude");
  });

  it("should refuse an OpenCode model outside the subscription provider when building the command", () => {
    expect(() => adapterFor("opencode").command("opencode/big-pickle")).toThrow(/opencode-go/);
    expect(adapterFor("opencode").command("opencode-go/glm-5.3")[0]).toBe("opencode");
  });

  it("should name the process each agent runs as, so it can be stopped", () => {
    expect(adapterFor("claude-code").processName).toBe("claude");
    expect(adapterFor("opencode").processName).toBe("opencode");
  });

  it("should read Claude Code usage, plan and outcome through its stream", () => {
    const stream = run(adapterFor("claude-code"), [claudeResult]);
    expect(stream.usage()).toEqual({
      inputTokens: 2,
      cacheCreationInputTokens: 17023,
      cacheReadInputTokens: 11803,
      outputTokens: 4,
    });
    expect(stream.outcome(exited)).toEqual({ kind: "completed", summary: "OK" });
  });

  it("should report a Claude Code plan limit through its stream", () => {
    const stream = run(adapterFor("claude-code"), [claudeRejected]);
    expect(stream.outcome(exited).kind).toBe("plan-limit");
    expect(stream.plan()?.status).toBe("rejected");
  });

  it("should recognise the final line of Claude Code and no final line of OpenCode", () => {
    expect(adapterFor("claude-code").isFinalLine?.(claudeResult)).toBe(true);
    expect(adapterFor("claude-code").isFinalLine?.(claudeRejected)).toBe(false);
    expect(adapterFor("opencode").isFinalLine).toBeUndefined();
  });

  it("should keep the streams of two attempts apart", () => {
    const adapter = adapterFor("claude-code");
    const first = run(adapter, [claudeResult]);
    const second = adapter.createStream();
    expect(first.usage().outputTokens).toBe(4);
    expect(second.usage().outputTokens).toBe(0);
  });

  it("should complete an OpenCode attempt through its stream", () => {
    const stream = run(adapterFor("opencode"), [openCodeText]);
    expect(stream.outcome(exited)).toEqual({ kind: "completed", summary: "OK" });
  });
});

describe("role requirements", () => {
  it("should offer as workers only the agents that read usage and detect the plan limit", () => {
    expect(agentsForRole("workers")).toEqual(["claude-code"]);
  });

  it("should offer as verifier only the agents with every tool denied by a fail-closed check", () => {
    expect(agentsForRole("verifier")).toEqual(["opencode"]);
  });

  it("should not offer OpenCode Go as workers until its stream shows usage and a plan limit", () => {
    expect(meetsRole("opencode", "workers")).toBe(false);
    expect(missingRequirements("opencode", "workers")).toEqual(["readsTokenUsage", "detectsPlanLimit"]);
  });

  it("should not offer Claude Code as verifier, since its tools cannot be denied with a fail-closed check", () => {
    expect(missingRequirements("claude-code", "verifier")).toEqual(["deniesEveryTool"]);
  });

  it("should report no missing requirement for an agent that meets the role", () => {
    expect(missingRequirements("claude-code", "workers")).toEqual([]);
  });
});
