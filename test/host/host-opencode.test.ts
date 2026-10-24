import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { askOpenCodeOnHost } from "../../src/workers/host-opencode.ts";

const FREE_GO_MODEL = "opencode-go/beam-free";

async function ask(prompt: string) {
  const logDir = await mkdtemp(join(tmpdir(), "verifier-log-"));
  return askOpenCodeOnHost({
    model: FREE_GO_MODEL,
    prompt,
    logPath: join(logDir, "verifier.jsonl"),
    limits: { deadline: new Date(Date.now() + 120_000), idleTimeoutMs: 90_000 },
  });
}

describe.skipIf(!process.env.FACTORY_OPENCODE_TESTS)("OpenCode verifier on the host", { timeout: 180_000 }, () => {
  it("answers with text", async () => {
    const result = await ask("Reply with the single word OK.");
    expect(result.outcome).toEqual({ kind: "completed", summary: "OK" });
  });

  it("cannot use a tool, and an attempt is not an answer", async () => {
    const marker = join(tmpdir(), `factory-verifier-marker-${Date.now()}`);
    const result = await ask(`Use your shell tool to run: touch ${marker} . Then reply DONE.`);
    expect(existsSync(marker)).toBe(false);
    expect(result.outcome.kind).not.toBe("completed");
  });
});
