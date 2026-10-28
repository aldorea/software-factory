import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execOk } from "../../src/workers/sh.ts";
import { askVerifier } from "../../src/workers/verifier.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(async ({ task }) => {
  if (task.result?.state === "fail") temp.keepAll();
  else await temp.removeAll();
});

const IMAGE = "software-factory/worker:dev";
const OPENCODE_KEY = process.env.OPENCODE_API_KEY;
const FREE_GO_MODEL = "opencode-go/beam-free";

async function ask(prompt: string) {
  const logDir = await temp.make("verifier-log-");
  return askVerifier({
    image: IMAGE,
    env: { OPENCODE_API_KEY: OPENCODE_KEY ?? "" },
    agent: { kind: "opencode", model: FREE_GO_MODEL },
    prompt,
    logPath: join(logDir, "verifier.jsonl"),
    limits: { deadline: new Date(Date.now() + 120_000), idleTimeoutMs: 90_000 },
  });
}

async function verifierContainers(): Promise<string> {
  return (await execOk("docker", ["ps", "-a", "--filter", "name=factory-verifier-", "--format", "{{.Names}}"])).trim();
}

describe.skipIf(!process.env.FACTORY_DOCKER_TESTS || !OPENCODE_KEY)("Verifier in Docker", { timeout: 180_000 }, () => {
  it("should answer with text and remove its container", async () => {
    const result = await ask("Reply with the single word OK.");
    expect(result.outcome, result.logPath).toEqual({ kind: "completed", summary: "OK" });
    expect(result.usageProblem, result.logPath).toBeUndefined();
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(await verifierContainers()).toBe("");
  });

  it("should not use a tool, and should not count an attempt as an answer", async () => {
    const result = await ask("Use your shell tool to run: touch probe.txt . Then reply DONE.");
    expect(result.outcome.kind, result.logPath).not.toBe("completed");
    expect(result.outcome).not.toMatchObject({ message: expect.stringMatching(/changed its directory|Agent not found/) });
  });
});

const CLAUDE_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;

async function askClaude(prompt: string, token: string) {
  const logDir = await temp.make("verifier-log-");
  return askVerifier({
    image: IMAGE,
    env: { CLAUDE_CODE_OAUTH_TOKEN: token },
    agent: { kind: "claude-code", model: "haiku" },
    prompt,
    logPath: join(logDir, "verifier.jsonl"),
    limits: { deadline: new Date(Date.now() + 120_000), idleTimeoutMs: 90_000 },
  });
}

describe.skipIf(!process.env.FACTORY_DOCKER_TESTS)("Claude Code verifier in Docker", { timeout: 180_000 }, () => {
  it("should load no tool with the CLI of the image, so a new CLI version that ignores a deny flag fails here first", async () => {
    const result = await askClaude("Reply with the single word OK.", "invalid-token");

    expect(result.outcome.kind, result.logPath).toBe("agent-error");
    expect(result.outcome, result.logPath).not.toMatchObject({ message: expect.stringMatching(/deny-all|did not report its tools/) });
    expect(await verifierContainers()).toBe("");
  });
});

describe.skipIf(!process.env.FACTORY_DOCKER_TESTS || !CLAUDE_TOKEN)("Claude Code verifier with a subscription", { timeout: 180_000 }, () => {
  it("should answer with text and remove its container", async () => {
    const result = await askClaude("Reply with the single word OK.", CLAUDE_TOKEN ?? "");

    expect(result.outcome, result.logPath).toEqual({ kind: "completed", summary: "OK" });
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(await verifierContainers()).toBe("");
  });

  it("should not use a tool", async () => {
    const result = await askClaude("Use your shell tool to run: touch probe.txt . Then reply DONE.", CLAUDE_TOKEN ?? "");

    expect(result.outcome, result.logPath).not.toMatchObject({ message: expect.stringMatching(/changed its directory|loaded tools/) });
  });
});
