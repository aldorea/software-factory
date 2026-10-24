import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adapterFor } from "../../src/workers/agents.ts";
import { runAttempt } from "../../src/workers/attempt.ts";
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
    const result = await runAttempt({
      adapter: adapterFor("claude-code"),
      model: "claude-haiku-5-5",
      prompt: "Reply OK.",
      limits: soon(),
      logPath: join(fake.dir, "log.jsonl"),
      launch: fake.run,
      stop: async () => undefined,
    });
    expect(result.outcome).toEqual({ kind: "completed", summary: "OK" });
    expect(result.usage.outputTokens).toBe(4);
    expect(result.logPath).toBe(join(fake.dir, "log.jsonl"));
  });

  it("should report the plan limit of Claude Code with the plan status", async () => {
    const fake = await emitter([claudeRejected]);
    const result = await runAttempt({
      adapter: adapterFor("claude-code"),
      model: "claude-haiku-5-5",
      prompt: "x",
      limits: soon(),
      logPath: join(fake.dir, "log.jsonl"),
      launch: fake.run,
      stop: async () => undefined,
    });
    expect(result.outcome.kind).toBe("plan-limit");
    expect(result.plan?.status).toBe("rejected");
  });

  it("should complete an OpenCode attempt with no plan status and zero usage", async () => {
    const fake = await emitter([JSON.stringify({ type: "text", part: { type: "text", text: "OK" } })]);
    const result = await runAttempt({
      adapter: adapterFor("opencode"),
      model: "opencode-go/glm-5.3",
      prompt: "x",
      limits: soon(),
      logPath: join(fake.dir, "log.jsonl"),
      launch: fake.run,
      stop: async () => undefined,
    });
    expect(result.outcome).toEqual({ kind: "completed", summary: "OK" });
    expect(result.plan).toBeUndefined();
    expect(result.usage.outputTokens).toBe(0);
  });

  it("should stop the process of the adapter at the deadline", async () => {
    const dir = await temp.make("attempt-");
    const stopped: string[] = [];
    const result = await runAttempt({
      adapter: adapterFor("opencode"),
      model: "opencode-go/glm-5.3",
      prompt: "x",
      limits: { deadline: new Date(Date.now() + 200), idleTimeoutMs: 10_000 },
      logPath: join(dir, "log.jsonl"),
      launch: () => ({ command: "sleep", args: ["30"] }),
      stop: async (processName) => {
        stopped.push(processName);
      },
    });
    expect(result.outcome).toEqual({ kind: "deadline" });
    expect(stopped).toEqual(["opencode"]);
  });

  it("should pass the command of the adapter to the launcher", async () => {
    const dir = await temp.make("attempt-");
    let received: string[] = [];
    await runAttempt({
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
    });
    expect(received).toEqual(adapterFor("claude-code").command("claude-haiku-5-5"));
  });
});
