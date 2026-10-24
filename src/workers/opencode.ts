import { emptyUsage, type AgentAdapter } from "./agent-adapter.ts";
import type { SupervisedProcess } from "./supervise.ts";
import type { AttemptOutcome } from "./types.ts";

export const SUBSCRIPTION_PROVIDER = "opencode-go";

export function openCodeArgs(
  model: string,
  options: { autoApprove: boolean; agent?: string } = { autoApprove: true },
): string[] {
  if (!model.startsWith(`${SUBSCRIPTION_PROVIDER}/`)) {
    throw new Error(`OpenCode model must use the ${SUBSCRIPTION_PROVIDER} provider, got "${model}"`);
  }
  if (model.slice(SUBSCRIPTION_PROVIDER.length + 1).startsWith("claude-")) {
    throw new Error(`OpenCode must not run a Claude model, got "${model}"`);
  }
  return [
    "opencode",
    "run",
    "--standalone",
    "--format",
    "json",
    ...(options.autoApprove ? ["--auto"] : []),
    ...(options.agent !== undefined ? ["--agent", options.agent] : []),
    "-m",
    model,
  ];
}

export interface OpenCodeStreamState {
  lastText: string;
  error?: string;
}

export function initialOpenCodeState(): OpenCodeStreamState {
  return { lastText: "" };
}

export function applyOpenCodeLine(state: OpenCodeStreamState, line: string): OpenCodeStreamState {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return state;
  }
  if (typeof event !== "object" || event === null || !("type" in event)) return state;

  if (
    event.type === "text" &&
    "part" in event &&
    typeof event.part === "object" &&
    event.part !== null &&
    "text" in event.part &&
    typeof event.part.text === "string"
  ) {
    return { ...state, lastText: event.part.text };
  }

  if (event.type === "error" && "error" in event) {
    return { ...state, error: errorMessage(event.error) };
  }

  return state;
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const message = "message" in error && typeof error.message === "string" ? error.message : undefined;
    const type = "type" in error && typeof error.type === "string" ? error.type : undefined;
    if (message && type) return `${type}: ${message}`;
    if (message) return message;
  }
  return JSON.stringify(error);
}

export function openCodeOutcome(state: OpenCodeStreamState, supervised: SupervisedProcess): AttemptOutcome {
  if (supervised.stopReason === "deadline") return { kind: "deadline" };
  if (supervised.stopReason === "idle-timeout") return { kind: "idle-timeout" };
  if (state.error === undefined && (supervised.exitCode === 0 || supervised.stopReason === "completion-grace")) {
    return { kind: "completed", summary: state.lastText };
  }
  return {
    kind: "agent-error",
    message: state.error ?? (supervised.stderrTail || "OpenCode ended with no output"),
    exitCode: supervised.exitCode,
  };
}

export const openCodeAdapter: AgentAdapter = {
  kind: "opencode",
  processName: "opencode",
  capabilities: { readsTokenUsage: false, detectsPlanLimit: false, deniesEveryTool: true },
  command: (model) => openCodeArgs(model),
  createStream() {
    let state = initialOpenCodeState();
    return {
      onLine(line) {
        state = applyOpenCodeLine(state, line);
      },
      usage: emptyUsage,
      plan: () => undefined,
      outcome: (supervised) => openCodeOutcome(state, supervised),
    };
  },
};
