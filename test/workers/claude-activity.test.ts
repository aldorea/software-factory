import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../../src/workers/claude-code.ts";
import type { ActivityEvent } from "../../src/workers/types.ts";

const lines = readFileSync(join(import.meta.dirname, "fixtures", "claude-activity.jsonl"), "utf8").trim().split("\n");
const [init, bash, rateLimit, toolResult, shortText, , thinking, finalText, result] = lines as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];
const WORKTREE = "/Users/sito/Documents/askwell/.factory/worktrees/23-health";

function activityOf(input: string[]): ActivityEvent[] {
  const stream = claudeCodeAdapter.createStream();
  return input.flatMap((line) => {
    stream.onLine(line);
    return stream.activity?.(line) ?? [];
  });
}

function withContent(line: string, content: unknown[]): string {
  const event = JSON.parse(line) as { message: { content: unknown[] } };
  event.message.content = content;
  return JSON.stringify(event);
}

function withTool(line: string, name: string, input: Record<string, unknown>): string {
  return withContent(line, [{ type: "tool_use", id: "toolu_swapped", name, input }]);
}

function withText(line: string, text: string): string {
  return withContent(line, [{ type: "text", text }]);
}

function withResult(line: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ ...JSON.parse(line), ...fields });
}

describe("Claude Code activity", () => {
  it("should translate a real stream into messages, tools with their target and the end, in order", () => {
    expect(activityOf(lines)).toEqual([
      {
        kind: "tool",
        tool: "Bash",
        target: "git status --short && find apps/nextjs/src/app/api/health -type f | xargs tail -n +1 && cat apps/ne…",
      },
      {
        kind: "message",
        text: "The files already exist. Next I'll check whether the middleware or auth blocks the route, then run …",
      },
      { kind: "message", text: "All checks pass. Next I'll commit." },
      {
        kind: "message",
        text: "`GET /api/health` is implemented and committed on the current branch as `ae3e0a5`. I didn't push or…",
      },
      { kind: "end", outcome: "completed" },
    ]);
  });

  it("should show a message by its first line only, cut to 100 characters", () => {
    const [message] = activityOf([init, finalText]);

    expect(message?.kind === "message" && message.text.length).toBe(100);
    expect(message?.kind === "message" && message.text.endsWith("…")).toBe(true);
    expect(message?.kind === "message" && message.text).not.toContain("\n");
  });

  it("should show the path of a tool relative to the worktree of the init line", () => {
    const targets = [
      { tool: "Read", input: { file_path: `${WORKTREE}/src/api/users.ts` } },
      { tool: "Edit", input: { file_path: `${WORKTREE}/src/api/users.ts`, old_string: "a", new_string: "b" } },
      { tool: "Grep", input: { pattern: "listUsers", path: `${WORKTREE}/src` } },
    ].map(({ tool, input }) => activityOf([init, withTool(bash, tool, input)]));

    expect(targets).toEqual([
      [{ kind: "tool", tool: "Read", target: "src/api/users.ts" }],
      [{ kind: "tool", tool: "Edit", target: "src/api/users.ts" }],
      [{ kind: "tool", tool: "Grep", target: "listUsers" }],
    ]);
  });

  it("should show a path outside the worktree as the agent wrote it, because only the worktree path is noise", () => {
    expect(activityOf([init, withTool(bash, "Read", { file_path: "/etc/hostname" })])).toEqual([
      { kind: "tool", tool: "Read", target: "/etc/hostname" },
    ]);
  });

  it("should give no event for the init line, thinking, tool results, rate limits, empty messages or lines that are not JSON", () => {
    const quiet = [init, rateLimit, toolResult, thinking];

    expect(activityOf([...quiet, "Warning: claude.ai MCP servers blocked by enterprise policy", "{broken"])).toEqual([]);
    expect(activityOf([withText(shortText, "\n\n")])).toEqual([]);
  });

  it("should give a tool with no target when its input has none of the usual fields", () => {
    expect(activityOf([withTool(bash, "ListAgents", {})])).toEqual([{ kind: "tool", tool: "ListAgents" }]);
  });

  it("should end with a failed outcome when the result is an error", () => {
    expect(activityOf([withResult(result, { subtype: "error_during_execution", is_error: true, result: "" })])).toEqual([
      { kind: "end", outcome: "failed" },
    ]);
  });

  it("should give every block of a message with several blocks, in order", () => {
    const toolUse = { type: "tool_use", id: "toolu_swapped", name: "Read", input: { file_path: "a.ts" } };

    expect(activityOf([withContent(bash, [{ type: "text", text: "Checking." }, toolUse])])).toEqual([
      { kind: "message", text: "Checking." },
      { kind: "tool", tool: "Read", target: "a.ts" },
    ]);
  });
});
