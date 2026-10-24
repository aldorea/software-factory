import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toEnvFile } from "./docker-runner.ts";
import { applyOpenCodeLine, initialOpenCodeState, openCodeArgs, openCodeOutcome } from "./opencode.ts";
import { exec, execOk } from "./sh.ts";
import { supervise } from "./supervise.ts";
import type { AttemptLimits, AttemptOutcome, AttemptResult } from "./types.ts";

const WORKDIR = "/home/agent/verifier";
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

export interface VerifierRequest {
  image: string;
  env: Record<string, string>;
  model: string;
  prompt: string;
  logPath: string;
  limits: AttemptLimits;
}

export async function askVerifier(request: VerifierRequest): Promise<AttemptResult> {
  const container = `factory-verifier-${randomUUID()}`;
  const secretsDir = await mkdtemp(join(tmpdir(), "factory-"));
  const startedAt = new Date();
  try {
    const envFile = join(secretsDir, "env");
    await writeFile(envFile, toEnvFile(request.env), { mode: 0o600 });
    try {
      await execOk("docker", ["run", "-d", "--init", "--name", container, "--env-file", envFile, request.image]);
    } finally {
      await rm(envFile, { force: true });
    }
    await execOk("docker", [
      "exec",
      container,
      "sh",
      "-c",
      `mkdir -p ${WORKDIR} && printf '%s' "$1" > ${WORKDIR}/${CONFIG_FILE}`,
      "sh",
      DENY_ALL_TOOLS,
    ]);

    let state = initialOpenCodeState();
    const supervised = await supervise({
      command: "docker",
      args: [
        "exec",
        "-i",
        "-w",
        WORKDIR,
        "-e",
        `PWD=${WORKDIR}`,
        container,
        ...openCodeArgs(request.model, { autoApprove: false, agent: VERIFIER_AGENT }),
      ],
      stdin: request.prompt,
      logPath: request.logPath,
      deadline: request.limits.deadline,
      idleTimeoutMs: request.limits.idleTimeoutMs,
      onLine: (line) => {
        state = applyOpenCodeLine(state, line);
      },
      terminate: async () => {
        await exec("docker", ["exec", container, "pkill", "-KILL", "-f", "opencode"]);
      },
    });

    const listing = await execOk("docker", ["exec", container, "ls", "-A", WORKDIR]);
    const leftovers = listing.split("\n").filter((name) => name !== "" && name !== CONFIG_FILE);
    const answered = openCodeOutcome(state, supervised);
    const outcome: AttemptOutcome =
      leftovers.length > 0
        ? {
            kind: "agent-error",
            message: `The verifier changed its directory despite the deny-all config: ${leftovers.join(", ")}`,
            exitCode: supervised.exitCode,
          }
        : answered.kind === "completed" && answered.summary.trim() === ""
          ? { kind: "agent-error", message: "The verifier gave no answer", exitCode: supervised.exitCode }
          : answered;

    return {
      outcome,
      usage: { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 },
      logPath: request.logPath,
      startedAt,
      endedAt: new Date(),
    };
  } finally {
    await exec("docker", ["rm", "-f", container]);
    await rm(secretsDir, { recursive: true, force: true });
  }
}
