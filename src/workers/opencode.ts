import type { AttemptOutcome } from "./types.ts";
import type { SupervisedRun } from "./supervise.ts";

export const SUBSCRIPTION_PROVIDER = "opencode-go";

export function openCodeArgs(prompt: string, model: string): string[] {
  if (!model.startsWith(`${SUBSCRIPTION_PROVIDER}/`)) {
    throw new Error(`OpenCode model must use the ${SUBSCRIPTION_PROVIDER} provider, got "${model}"`);
  }
  return ["opencode", "run", "--format", "json", "--auto", "-m", model, prompt];
}

export interface OpenCodeStreamState {
  lastText: string;
}

export function initialOpenCodeState(): OpenCodeStreamState {
  return { lastText: "" };
}

export function applyOpenCodeLine(state: OpenCodeStreamState, line: string): OpenCodeStreamState {
  try {
    const event: unknown = JSON.parse(line);
    if (
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === "text" &&
      "part" in event &&
      typeof event.part === "object" &&
      event.part !== null &&
      "text" in event.part &&
      typeof event.part.text === "string"
    ) {
      return { lastText: event.part.text };
    }
  } catch {
    return state;
  }
  return state;
}

export function openCodeOutcome(state: OpenCodeStreamState, run: SupervisedRun): AttemptOutcome {
  if (run.stopReason === "deadline") return { kind: "deadline" };
  if (run.stopReason === "idle-timeout") return { kind: "idle-timeout" };
  if (run.exitCode === 0 || run.stopReason === "completion-grace") {
    return { kind: "completed", summary: state.lastText };
  }
  return {
    kind: "agent-error",
    message: run.stderrTail || "OpenCode ended with no output",
    exitCode: run.exitCode,
  };
}
