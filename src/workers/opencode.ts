import { firstLine, toolTarget } from "./activity.ts";
import { emptyUsage, type AgentAdapter, type StreamOptions, type UsageProbe, type UsageReading } from "./agent-adapter.ts";
import type { SupervisedProcess } from "./supervise.ts";
import type { ActivityEvent, AttemptOutcome } from "./types.ts";

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
  sessionId?: string;
  error?: string;
  planLimit?: { resetsAt?: Date };
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
  const seen = sessionIdOf(event);
  if (seen !== undefined && state.sessionId === undefined) state = { ...state, sessionId: seen };

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
    const planLimit = isPlanLimit(event.error) ? { planLimit: planLimitOf(event, event.error) } : {};
    return { ...state, error: errorMessage(event.error), ...planLimit };
  }

  return state;
}

export function openCodeActivity(line: string, cwd?: string): ActivityEvent[] {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(event) || !isRecord(event.part)) return [];
  if (event.type === "text" && typeof event.part.text === "string") {
    const text = firstLine(event.part.text);
    return text === undefined ? [] : [{ kind: "message", text }];
  }
  if (event.type === "tool_use" && typeof event.part.tool === "string") {
    const target = isRecord(event.part.state) ? toolTarget(event.part.state.input, cwd) : undefined;
    return [{ kind: "tool", tool: event.part.tool, ...(target !== undefined ? { target } : {}) }];
  }
  return [];
}

export function openCodeFinish(outcome: AttemptOutcome): ActivityEvent[] {
  return [{ kind: "end", outcome: outcome.kind === "completed" ? "completed" : "failed" }];
}

function sessionIdOf(event: object): string | undefined {
  return "sessionID" in event && typeof event.sessionID === "string" && event.sessionID !== "" ? event.sessionID : undefined;
}

export function openCodeExportArgs(sessionId: string): string[] {
  return ["opencode", "session", "export", "--standalone", sessionId];
}

export function parseOpenCodeExport(text: string): UsageReading {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, problem: `the session export is not JSON: ${text.trim().slice(0, 200)}` };
  }
  const tokens = isRecord(data) && isRecord(data.info) ? data.info.tokens : undefined;
  const cache = isRecord(tokens) ? tokens.cache : undefined;
  if (
    !isRecord(tokens) ||
    !isRecord(cache) ||
    !isCount(tokens.input) ||
    !isCount(tokens.output) ||
    !isCount(tokens.reasoning) ||
    !isCount(cache.read) ||
    !isCount(cache.write)
  ) {
    return { ok: false, problem: "the session export has no token counts in info.tokens" };
  }
  return {
    ok: true,
    usage: {
      inputTokens: tokens.input,
      cacheCreationInputTokens: cache.write,
      cacheReadInputTokens: cache.read,
      outputTokens: tokens.output + tokens.reasoning,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPlanLimit(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const body = isRecord(error.response) && typeof error.response.body === "string" ? error.response.body : "";
  return error.type === "provider.quota" || body.includes("GoUsageLimitError");
}

function planLimitOf(event: object, error: unknown): { resetsAt?: Date } {
  const timestamp = "timestamp" in event ? event.timestamp : undefined;
  const retryAfterMs = isRecord(error) ? error.retryAfterMs : undefined;
  if (!isCount(timestamp) || !isCount(retryAfterMs)) return {};
  return { resetsAt: new Date(timestamp + retryAfterMs) };
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
  if (state.planLimit !== undefined) return { kind: "plan-limit", message: state.error ?? "plan limit reached", ...state.planLimit };
  if (state.error === undefined && (supervised.exitCode === 0 || supervised.stopReason === "completion-grace")) {
    return { kind: "completed", summary: state.lastText };
  }
  return {
    kind: "agent-error",
    message: state.error ?? (supervised.stderrTail || "OpenCode ended with no output"),
    exitCode: supervised.exitCode,
  };
}

export function openCodeUsageProbe(sessionId: () => string | undefined): UsageProbe {
  return {
    command() {
      const id = sessionId();
      return id === undefined ? undefined : openCodeExportArgs(id);
    },
    parse: parseOpenCodeExport,
  };
}

export const openCodeAdapter: AgentAdapter = {
  kind: "opencode",
  processName: "opencode",
  capabilities: { readsTokenUsage: true, detectsPlanLimit: true, deniesEveryTool: true, startsInteractiveSession: false },
  command: (model) => openCodeArgs(model),
  createStream(options) {
    let state = initialOpenCodeState();
    return {
      onLine(line) {
        state = applyOpenCodeLine(state, line);
      },
      activity: (line) => openCodeActivity(line, options?.cwd),
      finish: openCodeFinish,
      usage: emptyUsage,
      usageProbe: openCodeUsageProbe(() => state.sessionId),
      plan: () => undefined,
      outcome: (supervised) => openCodeOutcome(state, supervised),
    };
  },
};
