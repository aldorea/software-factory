import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adapterFor } from "../../src/workers/agents.ts";
import { performAttempt, type AttemptRequest } from "../../src/workers/attempt.ts";
import { WorkerLayerError } from "../../src/workers/failures.ts";
import { exec } from "../../src/workers/sh.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(async ({ task }) => {
  if (task.result?.state === "fail") temp.keepAll();
  else await temp.removeAll();
});

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

const fixtureDir = join(import.meta.dirname, "fixtures");
const realRun = readFileSync(join(fixtureDir, "opencode-run.jsonl"), "utf8").trim().split("\n");
const exportFile = join(fixtureDir, "opencode-export.json");

const noExport: AttemptRequest["exec"] = async () => {
  throw new Error("the export must not run");
};

function exporting(file: string, ran: string[][] = []): AttemptRequest["exec"] {
  return (command) => {
    ran.push(command);
    return exec("cat", [file]);
  };
}

async function emitter(lines: string[]) {
  const dir = await temp.make("attempt-");
  const script = join(dir, "emit.mjs");
  await writeFile(script, `process.stdin.resume();\nfor (const line of ${JSON.stringify(lines)}) console.log(line);\n`);
  return { dir, run: (_agentArgs: string[]) => ({ command: "node", args: [script] }) };
}

const soon = () => ({ deadline: new Date(Date.now() + 20_000), idleTimeoutMs: 10_000 });

describe("attempt", () => {
  it("should read usage and a completed outcome from a Claude Code stream", async () => {
    const fake = await emitter([claudeResult]);
    const result = await performAttempt({
      adapter: adapterFor("claude-code"),
      model: "claude-haiku-5-5",
      prompt: "Reply OK.",
      limits: soon(),
      logPath: join(fake.dir, "log.jsonl"),
      launch: fake.run,
      stop: async () => undefined,
      exec: noExport,
    });
    expect(result.outcome).toEqual({ kind: "completed", summary: "OK" });
    expect(result.usage.outputTokens).toBe(4);
    expect(result.logPath).toBe(join(fake.dir, "log.jsonl"));
  });

  it("should report the plan limit of Claude Code with the plan status", async () => {
    const fake = await emitter([claudeRejected]);
    const result = await performAttempt({
      adapter: adapterFor("claude-code"),
      model: "claude-haiku-5-5",
      prompt: "x",
      limits: soon(),
      logPath: join(fake.dir, "log.jsonl"),
      launch: fake.run,
      stop: async () => undefined,
      exec: noExport,
    });
    expect(result.outcome.kind).toBe("plan-limit");
    expect(result.plan?.status).toBe("rejected");
  });

  it("should read the usage of an OpenCode attempt from the session export, run in the same environment", async () => {
    const fake = await emitter(realRun);
    const ran: string[][] = [];
    const result = await performAttempt({
      adapter: adapterFor("opencode"),
      model: "opencode-go/glm-5.3",
      prompt: "x",
      limits: soon(),
      logPath: join(fake.dir, "log.jsonl"),
      launch: fake.run,
      stop: async () => undefined,
      exec: exporting(exportFile, ran),
    });
    expect(result.outcome).toEqual({ kind: "completed", summary: "OK" });
    expect(result.plan).toBeUndefined();
    expect(result.usage).toEqual({ inputTokens: 11138, cacheCreationInputTokens: 0, cacheReadInputTokens: 1356, outputTokens: 10 });
    expect(ran).toEqual([["opencode", "session", "export", "--standalone", "ses_e8db759a3ffezu7WMaX4o4J11V"]]);
  });

  it("should fail with usage-unreadable when the session export is not JSON, so a zero never stands for a missing number", async () => {
    const fake = await emitter(realRun);
    const failure = await performAttempt({
      adapter: adapterFor("opencode"),
      model: "opencode-go/glm-5.3",
      prompt: "x",
      limits: soon(),
      logPath: join(fake.dir, "log.jsonl"),
      launch: fake.run,
      stop: async () => undefined,
      exec: exporting(join(fixtureDir, "opencode-run.jsonl")),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WorkerLayerError);
    expect(failure).toMatchObject({ kind: "usage-unreadable", stage: "attempt" });
  });

  it("should fail with usage-unreadable when the session export command fails", async () => {
    const fake = await emitter(realRun);
    const failure = await performAttempt({
      adapter: adapterFor("opencode"),
      model: "opencode-go/glm-5.3",
      prompt: "x",
      limits: soon(),
      logPath: join(fake.dir, "log.jsonl"),
      launch: fake.run,
      stop: async () => undefined,
      exec: () => exec("sh", ["-c", "echo no such session >&2; exit 3"]),
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "usage-unreadable", stage: "attempt", message: expect.stringContaining("no such session") });
  });

  it("should fail with usage-unreadable when an OpenCode attempt completes with no session id in its stream", async () => {
    const fake = await emitter([JSON.stringify({ type: "text", part: { type: "text", text: "OK" } })]);
    const failure = await performAttempt({
      adapter: adapterFor("opencode"),
      model: "opencode-go/glm-5.3",
      prompt: "x",
      limits: soon(),
      logPath: join(fake.dir, "log.jsonl"),
      launch: fake.run,
      stop: async () => undefined,
      exec: noExport,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: "usage-unreadable", stage: "attempt" });
  });

  it("should report zero usage, with no export, when OpenCode fails before it opens a session", async () => {
    const fake = await emitter([JSON.stringify({ type: "error", error: { type: "provider.no-route", message: "no route" } })]);
    const result = await performAttempt({
      adapter: adapterFor("opencode"),
      model: "opencode-go/glm-5.3",
      prompt: "x",
      limits: soon(),
      logPath: join(fake.dir, "log.jsonl"),
      launch: fake.run,
      stop: async () => undefined,
      exec: noExport,
    });
    expect(result.outcome.kind).toBe("agent-error");
    expect(result.usage.outputTokens).toBe(0);
  });

  it("should not run an export for Claude Code, which reports its usage in the stream", async () => {
    const fake = await emitter([claudeResult]);
    const result = await performAttempt({
      adapter: adapterFor("claude-code"),
      model: "claude-haiku-5-5",
      prompt: "x",
      limits: soon(),
      logPath: join(fake.dir, "log.jsonl"),
      launch: fake.run,
      stop: async () => undefined,
      exec: noExport,
    });
    expect(result.usage.outputTokens).toBe(4);
  });

  it("should stop the process of the adapter at the deadline", async () => {
    const dir = await temp.make("attempt-");
    const stopped: string[] = [];
    const result = await performAttempt({
      adapter: adapterFor("opencode"),
      model: "opencode-go/glm-5.3",
      prompt: "x",
      limits: { deadline: new Date(Date.now() + 200), idleTimeoutMs: 10_000 },
      logPath: join(dir, "log.jsonl"),
      launch: () => ({ command: "sleep", args: ["30"] }),
      stop: async (processName) => {
        stopped.push(processName);
      },
      exec: noExport,
    });
    expect(result.outcome).toEqual({ kind: "deadline" });
    expect(stopped).toEqual(["opencode"]);
  });

  it("should pass the command of the adapter to the launcher", async () => {
    const dir = await temp.make("attempt-");
    let received: string[] = [];
    await performAttempt({
      adapter: adapterFor("claude-code"),
      model: "claude-haiku-5-5",
      prompt: "x",
      limits: soon(),
      logPath: join(dir, "log.jsonl"),
      launch: (agentArgs) => {
        received = agentArgs;
        return { command: "true", args: [] };
      },
      stop: async () => undefined,
      exec: noExport,
    });
    expect(received).toEqual(adapterFor("claude-code").command("claude-haiku-5-5"));
  });
});
