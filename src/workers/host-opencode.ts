import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOpenCodeLine, initialOpenCodeState, openCodeArgs, openCodeOutcome } from "./opencode.ts";
import { supervise } from "./supervise.ts";
import type { AttemptLimits, AttemptOutcome, AttemptResult } from "./types.ts";

const CONFIG_FILE = "opencode.jsonc";

const VERIFIER_AGENT = "verifier";
const DENY_ALL = [{ action: "*", resource: "*", effect: "deny" }];

export const DENY_ALL_TOOLS = JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  permissions: DENY_ALL,
  agents: {
    [VERIFIER_AGENT]: { description: "Answers from the prompt alone, with no tools", mode: "primary", permissions: DENY_ALL },
  },
});

export interface HostOpenCodeRequest {
  model: string;
  prompt: string;
  logPath: string;
  limits: AttemptLimits;
}

export async function askOpenCodeOnHost(request: HostOpenCodeRequest): Promise<AttemptResult> {
  const dir = await mkdtemp(join(tmpdir(), "factory-verifier-"));
  const startedAt = new Date();
  try {
    await writeFile(join(dir, CONFIG_FILE), DENY_ALL_TOOLS);
    let state = initialOpenCodeState();
    const [command, ...args] = openCodeArgs(request.model, { autoApprove: false, agent: VERIFIER_AGENT });
    const runResult = await supervise({
      command: command ?? "opencode",
      args,
      cwd: dir,
      stdin: request.prompt,
      logPath: request.logPath,
      deadline: request.limits.deadline,
      idleTimeoutMs: request.limits.idleTimeoutMs,
      onLine: (line) => {
        state = applyOpenCodeLine(state, line);
      },
    });

    const leftovers = (await readdir(dir)).filter((name) => name !== CONFIG_FILE);
    const answered = openCodeOutcome(state, runResult);
    const outcome: AttemptOutcome =
      leftovers.length > 0
        ? {
            kind: "agent-error",
            message: `The verifier changed its directory despite the deny-all config: ${leftovers.join(", ")}`,
            exitCode: runResult.exitCode,
          }
        : answered.kind === "completed" && answered.summary.trim() === ""
          ? { kind: "agent-error", message: "The verifier gave no answer", exitCode: runResult.exitCode }
          : answered;

    return {
      outcome,
      usage: { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 },
      logPath: request.logPath,
      startedAt,
      endedAt: new Date(),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
