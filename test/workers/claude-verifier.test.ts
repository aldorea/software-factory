import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyClaudeLine, claudeVerifierArgs, initialClaudeState, type ClaudeStreamState } from "../../src/workers/claude-code.ts";
import type { SupervisedProcess } from "../../src/workers/supervise.ts";
import { claudeVerifierOutcome, verifierActivity } from "../../src/workers/verifier.ts";

const exited: SupervisedProcess = { stopReason: "exited", exitCode: 0, stderrTail: "" };
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8").trim();
const initWithNoTools = fixture("claude-init-no-tools.jsonl");
const initWithDefaultTools = fixture("claude-init-default.jsonl");

const answer = (text: string) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, api_error_status: null, usage: {} });

const assistantText = (text: string) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });

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

  it("should report a deadline as a deadline, even when no init event came", () => {
    expect(claudeVerifierOutcome(initialClaudeState(), { stopReason: "deadline", exitCode: null, stderrTail: "" }, "")).toEqual({
      kind: "deadline",
    });
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

describe("Claude Code verifier activity", () => {
  it("should translate the stream of the verifier into the same events as the stream of a worker, so a verifier that uses no tools shows only messages and its end", () => {
    const activity = verifierActivity("claude-code");

    const events = [initWithNoTools, assistantText("The test only checks the status code.\nIt never reads the page."), answer("REFUTE")].flatMap(activity.onLine);

    expect(events).toEqual([
      { kind: "message", text: "The test only checks the status code." },
      { kind: "end", outcome: "completed" },
    ]);
  });

  it("should add no end event when the verifier outcome is known, because the result line of the stream already gave it", () => {
    expect(verifierActivity("claude-code").finish({ kind: "completed", summary: "ACCEPT" })).toEqual([]);
  });
});
