import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyClaudeLine, claudeVerifierArgs, initialClaudeState, type ClaudeStreamState } from "../../src/workers/claude-code.ts";
import type { SupervisedProcess } from "../../src/workers/supervise.ts";
import { claudeVerifierOutcome } from "../../src/workers/verifier.ts";

const exited: SupervisedProcess = { stopReason: "exited", exitCode: 0, stderrTail: "" };
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8").trim();
const initWithNoTools = fixture("claude-init-no-tools.jsonl");
const initWithDefaultTools = fixture("claude-init-default.jsonl");

const answer = (text: string) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, api_error_status: null, usage: {} });

function feed(lines: string[]): ClaudeStreamState {
  return lines.reduce(applyClaudeLine, initialClaudeState());
}

describe("Claude Code verifier command", () => {
  it("should deny every built-in tool, every MCP tool and every customization of the image", () => {
    const args = claudeVerifierArgs("sonnet");

    expect(args).toEqual(expect.arrayContaining(["--tools", "", "--disallowedTools", "*", "--strict-mcp-config"]));
    expect(args).toEqual(expect.arrayContaining(["--safe-mode", "--disable-slash-commands", "--permission-prompts", "none"]));
    expect(args.slice(-2)).toEqual(["-p", "-"]);
  });

  it("should never skip the permission checks, so a tool that slips through is still denied", () => {
    expect(claudeVerifierArgs("sonnet")).not.toContain("--dangerously-skip-permissions");
  });
});

describe("Claude Code verifier outcome", () => {
  it("should accept the answer when the init event lists no tools and no MCP servers", () => {
    expect(claudeVerifierOutcome(feed([initWithNoTools, answer("ACCEPT")]), exited, "")).toEqual({
      kind: "completed",
      summary: "ACCEPT",
    });
  });

  it("should reject the answer when the init event lists tools, because the denial did not load", () => {
    const outcome = claudeVerifierOutcome(feed([initWithDefaultTools, answer("ACCEPT")]), exited, "");

    expect(outcome).toMatchObject({ kind: "agent-error", exitCode: 0 });
    expect(outcome.kind === "agent-error" && outcome.message).toMatch(/^The verifier loaded tools despite the deny-all flags: Task, Bash/);
  });

  it("should reject the answer when no init event came, because nothing shows the denial loaded", () => {
    expect(claudeVerifierOutcome(feed([answer("ACCEPT")]), exited, "")).toEqual({
      kind: "agent-error",
      message: "The verifier did not report its tools, so the deny-all flags cannot be checked",
      exitCode: 0,
    });
  });

  it("should reject the answer when the init event has no list of tools", () => {
    const init = JSON.stringify({ type: "system", subtype: "init", mcp_servers: [] });

    expect(claudeVerifierOutcome(feed([init, answer("ACCEPT")]), exited, "")).toMatchObject({ kind: "agent-error" });
  });

  it("should reject the answer when the verifier left a file in its directory", () => {
    expect(claudeVerifierOutcome(feed([initWithNoTools, answer("ACCEPT")]), exited, "probe.txt\n")).toEqual({
      kind: "agent-error",
      message: "The verifier changed its directory despite the deny-all config: probe.txt",
      exitCode: 0,
    });
  });

  it("should treat an empty answer as an agent error, so silence never passes a criterion", () => {
    expect(claudeVerifierOutcome(feed([initWithNoTools, answer(" ")]), exited, "")).toEqual({
      kind: "agent-error",
      message: "The verifier gave no answer",
      exitCode: 0,
    });
  });
});
