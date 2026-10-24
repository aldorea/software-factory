import { describe, expect, it } from "vitest";
import {
  applyClaudeLine,
  claudeCodeArgs,
  claudeOutcome,
  initialClaudeState,
  isClaudeFinalLine,
  type ClaudeStreamState,
} from "../../src/workers/claude-code.ts";
import type { SupervisedProcess } from "../../src/workers/supervise.ts";

const exited: SupervisedProcess = { stopReason: "exited", exitCode: 0, stderrTail: "" };

const rateLimit = (status: string, fiveHour: number, sevenDay: number) =>
  JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: {
      status,
      resetsAt: 1792792800,
      rateLimitType: "seven_day",
      utilization: sevenDay,
      unifiedWindows: {
        five_hour: { utilization: fiveHour, resetsAt: 1792793400 },
        seven_day: { utilization: sevenDay, resetsAt: 1792792800 },
      },
    },
  });

const result = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "OK",
    api_error_status: null,
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 17023,
      cache_read_input_tokens: 11803,
      output_tokens: 4,
    },
    ...overrides,
  });

function feed(lines: string[]): ClaudeStreamState {
  return lines.reduce(applyClaudeLine, initialClaudeState());
}

describe("Claude Code command", () => {
  it("should take the prompt from stdin, not from the arguments", () => {
    const args = claudeCodeArgs("claude-haiku-5-5");
    expect(args.slice(-2)).toEqual(["-p", "-"]);
    expect(args).toContain("--print");
    expect(args).toContain("claude-haiku-5-5");
  });
});

describe("Claude Code stream", () => {
  it("should read usage and a successful result", () => {
    const state = feed([
      "Warning: claude.ai MCP servers blocked by enterprise policy",
      JSON.stringify({ type: "system", subtype: "init" }),
      rateLimit("allowed_warning", 0.04, 0.81),
      result(),
    ]);

    expect(state.usage).toEqual({
      inputTokens: 2,
      cacheCreationInputTokens: 17023,
      cacheReadInputTokens: 11803,
      outputTokens: 4,
    });
    expect(state.plan?.status).toBe("allowed_warning");
    expect(state.plan?.windows.seven_day?.utilization).toBe(0.81);
    expect(claudeOutcome(state, exited)).toEqual({ kind: "completed", summary: "OK" });
  });

  it("should add the usage of each result", () => {
    const state = feed([result(), result()]);
    expect(state.usage.outputTokens).toBe(8);
  });

  it("should detect the final line", () => {
    expect(isClaudeFinalLine(result())).toBe(true);
    expect(isClaudeFinalLine(rateLimit("allowed", 0, 0))).toBe(false);
    expect(isClaudeFinalLine("not json")).toBe(false);
  });

  it("should report a plan limit when the plan is rejected and wait for the last exhausted window", () => {
    const state = feed([
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: 1792793400,
          unifiedWindows: {
            five_hour: { utilization: 1, resetsAt: 1792793400 },
            seven_day: { utilization: 1, resetsAt: 1792800000 },
          },
        },
      }),
      result({ is_error: true, subtype: "error_during_execution", result: "" }),
    ]);

    const outcome = claudeOutcome(state, { ...exited, exitCode: 1 });
    expect(outcome.kind).toBe("plan-limit");
    expect(outcome.kind === "plan-limit" && outcome.resetsAt).toEqual(new Date(1792800000 * 1000));
  });

  it("should report a plan limit from a 429 result", () => {
    const state = feed([result({ is_error: true, api_error_status: 429, result: "Request rejected" })]);
    expect(claudeOutcome(state, exited).kind).toBe("plan-limit");
  });

  it("should report an agent error when there is no result", () => {
    const outcome = claudeOutcome(initialClaudeState(), { stopReason: "exited", exitCode: 1, stderrTail: "boom" });
    expect(outcome).toEqual({ kind: "agent-error", message: "boom", exitCode: 1 });
  });

  it("should put deadline and idle timeout before anything else", () => {
    const state = feed([result()]);
    expect(claudeOutcome(state, { ...exited, stopReason: "deadline" }).kind).toBe("deadline");
    expect(claudeOutcome(state, { ...exited, stopReason: "idle-timeout" }).kind).toBe("idle-timeout");
  });

  it("should treat a hung process after the result as completed", () => {
    const state = feed([result()]);
    expect(claudeOutcome(state, { ...exited, stopReason: "completion-grace", exitCode: null }).kind).toBe(
      "completed",
    );
  });
});
