import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyUsage, type UsageReading } from "./agent-adapter.ts";
import { adapterFor } from "./agents.ts";
import { applyClaudeLine, claudeOutcome, claudeVerifierArgs, initialClaudeState, type ClaudeStreamState } from "./claude-code.ts";
import { toEnvFile } from "./docker-runner.ts";
import {
  applyOpenCodeLine,
  initialOpenCodeState,
  openCodeArgs,
  openCodeOutcome,
  openCodeUsageProbe,
  type OpenCodeStreamState,
} from "./opencode.ts";
import { exec, execOk } from "./sh.ts";
import { supervise, type SupervisedProcess } from "./supervise.ts";
import { readUsage } from "./usage.ts";
import type { ActivityEvent, ActivitySink, AgentKind, AgentSpec, AttemptLimits, AttemptOutcome, AttemptResult, ExecResult } from "./types.ts";

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
  agent: AgentSpec;
  prompt: string;
  logPath: string;
  limits: AttemptLimits;
  onActivity?: ActivitySink;
}

export interface VerifierResult extends AttemptResult {
  usageProblem?: string;
}

interface VerifierSession {
  setup: string[];
  args: string[];
  onLine(line: string): void;
  outcome(supervised: SupervisedProcess, listing: string): AttemptOutcome;
  usage(outcome: AttemptOutcome, exec: (command: string[]) => Promise<ExecResult>): Promise<UsageReading>;
}

function verifierSession(agent: AgentSpec): VerifierSession {
  if (agent.kind === "claude-code") {
    let state = initialClaudeState();
    return {
      setup: ["mkdir", "-p", WORKDIR],
      args: claudeVerifierArgs(agent.model),
      onLine: (line) => {
        state = applyClaudeLine(state, line);
      },
      outcome: (supervised, listing) => claudeVerifierOutcome(state, supervised, listing),
      usage: async () => ({ ok: true, usage: state.usage }),
    };
  }
  let state = initialOpenCodeState();
  return {
    setup: ["sh", "-c", `mkdir -p ${WORKDIR} && printf '%s' "$1" > ${WORKDIR}/${CONFIG_FILE}`, "sh", DENY_ALL_TOOLS],
    args: openCodeArgs(agent.model, { autoApprove: false, agent: VERIFIER_AGENT }),
    onLine: (line) => {
      state = applyOpenCodeLine(state, line);
    },
    outcome: (supervised, listing) => verifierOutcome(state, supervised, listing),
    usage: (outcome, exec) => readUsage(openCodeUsageProbe(() => state.sessionId), emptyUsage(), outcome, exec),
  };
}

export interface VerifierActivity {
  onLine(line: string): ActivityEvent[];
  finish(outcome: AttemptOutcome): ActivityEvent[];
}

export function verifierActivity(kind: AgentKind): VerifierActivity {
  const stream = adapterFor(kind).createStream();
  return {
    onLine: (line) => {
      stream.onLine(line);
      return stream.activity?.(line) ?? [];
    },
    finish: (outcome) => stream.finish?.(outcome) ?? [],
  };
}

export async function askVerifier(request: VerifierRequest): Promise<VerifierResult> {
  const container = `factory-verifier-${randomUUID()}`;
  const secretsDir = await mkdtemp(join(tmpdir(), "factory-"));
  const startedAt = new Date();
  const session = verifierSession(request.agent);
  const activity = verifierActivity(request.agent.kind);
  try {
    const envFile = join(secretsDir, "env");
    await writeFile(envFile, toEnvFile(request.env), { mode: 0o600 });
    try {
      await execOk("docker", ["run", "-d", "--init", "--name", container, "--env-file", envFile, request.image]);
    } finally {
      await rm(envFile, { force: true });
    }
    await execOk("docker", ["exec", container, ...session.setup]);

    const supervised = await supervise({
      command: "docker",
      args: ["exec", "-i", "-w", WORKDIR, "-e", `PWD=${WORKDIR}`, container, ...session.args],
      stdin: request.prompt,
      logPath: request.logPath,
      deadline: request.limits.deadline,
      idleTimeoutMs: request.limits.idleTimeoutMs,
      onLine: (line) => {
        session.onLine(line);
        const { onActivity } = request;
        if (onActivity === undefined) return;
        for (const event of activity.onLine(line)) onActivity(event);
      },
      terminate: async () => {
        await exec("docker", ["exec", container, "pkill", "-KILL", "-f", adapterFor(request.agent.kind).processName]);
      },
    });

    const listing = await execOk("docker", ["exec", container, "ls", "-A", WORKDIR]);

    const outcome = session.outcome(supervised, listing);
    for (const event of activity.finish(outcome)) request.onActivity?.(event);
    const reading = await session.usage(outcome, (command) =>
      exec("docker", ["exec", "-w", WORKDIR, "-e", `PWD=${WORKDIR}`, container, ...command]),
    );

    return {
      outcome,
      usage: reading.ok ? reading.usage : emptyUsage(),
      ...(reading.ok ? {} : { usageProblem: `The token usage of the verifier cannot be read: ${reading.problem}` }),
      logPath: request.logPath,
      startedAt,
      endedAt: new Date(),
    };
  } finally {
    await exec("docker", ["rm", "-f", container]);
    await rm(secretsDir, { recursive: true, force: true });
  }
}

export function verifierOutcome(
  state: OpenCodeStreamState,
  supervised: SupervisedProcess,
  directoryListing: string,
): AttemptOutcome {
  return checkedAnswer(openCodeOutcome(state, supervised), supervised, directoryListing, [CONFIG_FILE]);
}

export function claudeVerifierOutcome(
  state: ClaudeStreamState,
  supervised: SupervisedProcess,
  directoryListing: string,
): AttemptOutcome {
  const answered = claudeOutcome(state, supervised);
  if (answered.kind === "deadline" || answered.kind === "idle-timeout") return answered;
  const { tools, mcpServers } = state.init ?? {};
  if (tools === undefined || mcpServers === undefined) {
    return {
      kind: "agent-error",
      message: "The verifier did not report its tools, so the deny-all flags cannot be checked",
      exitCode: supervised.exitCode,
    };
  }
  const loaded = [...tools, ...mcpServers];
  if (loaded.length > 0) {
    return {
      kind: "agent-error",
      message: `The verifier loaded tools despite the deny-all flags: ${loaded.join(", ")}`,
      exitCode: supervised.exitCode,
    };
  }
  return checkedAnswer(answered, supervised, directoryListing, []);
}

function checkedAnswer(
  answered: AttemptOutcome,
  supervised: SupervisedProcess,
  directoryListing: string,
  kept: string[],
): AttemptOutcome {
  const leftovers = directoryListing.split("\n").filter((name) => name !== "" && !kept.includes(name));
  if (leftovers.length > 0) {
    return {
      kind: "agent-error",
      message: `The verifier changed its directory despite the deny-all config: ${leftovers.join(", ")}`,
      exitCode: supervised.exitCode,
    };
  }
  if (answered.kind === "completed" && answered.summary.trim() === "") {
    return { kind: "agent-error", message: "The verifier gave no answer", exitCode: supervised.exitCode };
  }
  return answered;
}
