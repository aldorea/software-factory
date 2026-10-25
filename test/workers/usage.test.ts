import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyUsage } from "../../src/workers/agent-adapter.ts";
import { openCodeUsageProbe } from "../../src/workers/opencode.ts";
import { exec } from "../../src/workers/sh.ts";
import { readUsage } from "../../src/workers/usage.ts";

const exportFile = join(import.meta.dirname, "fixtures", "opencode-export.json");
const completed = { kind: "completed" as const, summary: "OK" };
const forbidden = async () => {
  throw new Error("the export must not run");
};

describe("readUsage", () => {
  it("should run the probe command and read the usage from its output", async () => {
    const ran: string[][] = [];
    const reading = await readUsage(openCodeUsageProbe(() => "ses_1"), emptyUsage(), completed, (command) => {
      ran.push(command);
      return exec("cat", [exportFile]);
    });
    expect(reading).toEqual({
      ok: true,
      usage: { inputTokens: 11138, cacheCreationInputTokens: 0, cacheReadInputTokens: 1356, outputTokens: 10 },
    });
    expect(ran).toEqual([["opencode", "session", "export", "--standalone", "ses_1"]]);
  });

  it("should report a failing export command with its exit code and error output", async () => {
    const reading = await readUsage(openCodeUsageProbe(() => "ses_1"), emptyUsage(), completed, () =>
      exec("sh", ["-c", "echo no such session >&2; exit 3"]),
    );
    expect(reading).toMatchObject({ ok: false, problem: expect.stringContaining("exited with 3: no such session") });
  });

  it("should report an unreadable export as a problem", async () => {
    const reading = await readUsage(openCodeUsageProbe(() => "ses_1"), emptyUsage(), completed, () => exec("echo", ["oops"]));
    expect(reading).toMatchObject({ ok: false });
  });

  it("should report a problem when the agent completed with no session to export", async () => {
    expect(await readUsage(openCodeUsageProbe(() => undefined), emptyUsage(), completed, forbidden)).toMatchObject({ ok: false });
  });

  it("should fall back to the usage of the stream when no session opened and the agent did not complete", async () => {
    const outcome = { kind: "agent-error" as const, message: "no route", exitCode: 1 };
    expect(await readUsage(openCodeUsageProbe(() => undefined), emptyUsage(), outcome, forbidden)).toEqual({
      ok: true,
      usage: emptyUsage(),
    });
  });
});
