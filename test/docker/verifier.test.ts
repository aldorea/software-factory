import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execOk } from "../../src/workers/sh.ts";
import { askVerifier } from "../../src/workers/verifier.ts";

const IMAGE = "software-factory/worker:dev";
const OPENCODE_KEY = process.env.OPENCODE_API_KEY;
const FREE_GO_MODEL = "opencode-go/beam-free";

async function ask(prompt: string) {
  const logDir = await mkdtemp(join(tmpdir(), "verifier-log-"));
  return askVerifier({
    image: IMAGE,
    env: { OPENCODE_API_KEY: OPENCODE_KEY ?? "" },
    model: FREE_GO_MODEL,
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
    expect(await verifierContainers()).toBe("");
  });

  it("should not use a tool, and should not count an attempt as an answer", async () => {
    const result = await ask("Use your shell tool to run: touch probe.txt . Then reply DONE.");
    expect(result.outcome.kind, result.logPath).not.toBe("completed");
    expect(result.outcome).not.toMatchObject({ message: expect.stringMatching(/changed its directory|Agent not found/) });
  });
});
