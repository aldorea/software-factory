import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openCodeAdapter } from "../../src/workers/opencode.ts";
import type { ActivityEvent, AttemptOutcome } from "../../src/workers/types.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8").trim().split("\n");
const realRun = fixture("opencode-run.jsonl");
const realLimit = fixture("opencode-go-limit.jsonl");

function activityOf(lines: string[]): ActivityEvent[] {
  const stream = openCodeAdapter.createStream();
  return lines.flatMap((line) => {
    stream.onLine(line);
    return stream.activity?.(line) ?? [];
  });
}

function withText(line: string, text: string): string {
  const event = JSON.parse(line) as { part: { text: string } };
  event.part.text = text;
  return JSON.stringify(event);
}

function endOf(outcome: AttemptOutcome): ActivityEvent[] {
  return openCodeAdapter.createStream().finish?.(outcome) ?? [];
}

describe("OpenCode activity", () => {
  it("should show the message of a real run and nothing for its step start, because its stream has no tool events", () => {
    expect(activityOf(realRun)).toEqual([{ kind: "message", text: "OK" }]);
  });

  it("should show a message by its first line only, cut to 100 characters", () => {
    const textLine = realRun[1] as string;
    const long = `${"Writing the report with every detail of the change ".repeat(4)}\nsecond line`;

    const [message] = activityOf([withText(textLine, long)]);

    expect(message?.kind === "message" && message.text.length).toBe(100);
    expect(message?.kind === "message" && message.text.endsWith("…")).toBe(true);
    expect(message?.kind === "message" && message.text).not.toContain("second line");
  });

  it("should show nothing for a message with no text", () => {
    expect(activityOf([withText(realRun[1] as string, "  \n ")])).toEqual([]);
  });

  it("should show nothing for an error line, because the end of the attempt carries the failure", () => {
    expect(activityOf(realLimit)).toEqual([]);
  });

  it("should end the activity as completed when the attempt completed, because the stream has no final line", () => {
    expect(endOf({ kind: "completed", summary: "OK" })).toEqual([{ kind: "end", outcome: "completed" }]);
  });

  it("should end the activity as failed when the attempt did not complete", () => {
    const failures: AttemptOutcome[] = [
      { kind: "deadline" },
      { kind: "idle-timeout" },
      { kind: "plan-limit", message: "Subscription quota exceeded." },
      { kind: "agent-error", message: "boom", exitCode: 1 },
    ];
    for (const outcome of failures) expect(endOf(outcome)).toEqual([{ kind: "end", outcome: "failed" }]);
  });
});
