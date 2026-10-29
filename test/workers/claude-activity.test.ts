import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../../src/workers/claude-code.ts";
import type { ActivityEvent } from "../../src/workers/types.ts";

const lines = readFileSync(join(import.meta.dirname, "fixtures", "claude-activity.jsonl"), "utf8").trim().split("\n");

function activityOf(input: string[]): ActivityEvent[] {
  const stream = claudeCodeAdapter.createStream();
  return input.flatMap((line) => {
    stream.onLine(line);
    return stream.activity?.(line) ?? [];
  });
}

describe("Claude Code activity", () => {
  it("should translate a stream into messages, tools with their target and the end, in order", () => {
    const events = activityOf(lines);

    expect(events.map((event) => event.kind)).toEqual([
      "message",
      "tool",
      "tool",
      "tool",
      "tool",
      "tool",
      "message",
      "end",
    ]);
    expect(events[0]).toEqual({ kind: "message", text: "I will start by reading the users module." });
    expect(events[1]).toEqual({ kind: "tool", tool: "Read", target: "src/api/users.ts" });
    expect(events[2]).toEqual({ kind: "tool", tool: "Edit", target: "src/api/users.ts" });
    expect(events[3]).toEqual({ kind: "tool", tool: "Bash", target: "pnpm test" });
    expect(events[4]).toEqual({ kind: "tool", tool: "Grep", target: "listUsers" });
    expect(events[7]).toEqual({ kind: "end", outcome: "completed" });
  });

  it("should show a message by its first line only, cut to 100 characters", () => {
    const events = activityOf(lines);
    const long = events[6];

    expect(long?.kind === "message" && long.text).toMatch(/^Tests pass\. Writing the report with every detail/);
    expect(long?.kind === "message" && long.text.length).toBe(100);
    expect(long?.kind === "message" && long.text.endsWith("…")).toBe(true);
  });

  it("should show a path outside the worktree as the agent wrote it, because only the worktree path is noise", () => {
    const events = activityOf(lines);

    expect(events[5]).toEqual({ kind: "tool", tool: "Read", target: "/etc/hostname" });
  });

  it("should give no event for thinking, tool results, rate limits, empty messages or lines that are not JSON", () => {
    const quiet = lines.filter((line) => {
      const type = JSON.parse(line).type as string;
      return type === "user" || type === "rate_limit_event" || (type === "assistant" && !line.includes('"tool_use"') && !line.includes('"text"'));
    });

    expect(activityOf([...quiet, "Warning: claude.ai MCP servers blocked by enterprise policy", "{broken"])).toEqual([]);
    expect(activityOf([JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "\n\n" }] } })])).toEqual([]);
  });

  it("should give a tool with no target when its input has none of the usual fields", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_09", name: "ListAgents", input: {} }] },
    });

    expect(activityOf([line])).toEqual([{ kind: "tool", tool: "ListAgents" }]);
  });

  it("should end with a failed outcome when the result is an error", () => {
    const line = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "" });

    expect(activityOf([line])).toEqual([{ kind: "end", outcome: "failed" }]);
  });

  it("should give every block of a message with several blocks, in order", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "toolu_10", name: "Read", input: { file_path: "a.ts" } },
        ],
      },
    });

    expect(activityOf([line])).toEqual([
      { kind: "message", text: "Checking." },
      { kind: "tool", tool: "Read", target: "a.ts" },
    ]);
  });
});
