import type { AttemptOutcome } from "./types.ts";
import type { SupervisedRun } from "./supervise.ts";

export const SUBSCRIPTION_PROVIDER = "opencode-go";

export function openCodeArgs(model: string): string[] {
  if (!model.startsWith(`${SUBSCRIPTION_PROVIDER}/`)) {
    throw new Error(`OpenCode model must use the ${SUBSCRIPTION_PROVIDER} provider, got "${model}"`);
  }
  return ["opencode", "run", "--format", "json", "--auto", "-m", model];
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

export function openCodeOutcome(state: OpenCodeStreamState, run: SupervisedRun): AttemptOutcome {
  if (run.stopReason === "deadline") return { kind: "deadline" };
  if (run.stopReason === "idle-timeout") return { kind: "idle-timeout" };
  if (state.error === undefined && (run.exitCode === 0 || run.stopReason === "completion-grace")) {
    return { kind: "completed", summary: state.lastText };
  }
  return {
    kind: "agent-error",
    message: state.error ?? (run.stderrTail || "OpenCode ended with no output"),
    exitCode: run.exitCode,
  };
}
