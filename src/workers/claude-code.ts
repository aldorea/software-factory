import { firstLine } from "./activity.ts";
import { emptyUsage, type AgentAdapter } from "./agent-adapter.ts";
import type { SupervisedProcess } from "./supervise.ts";
import type { ActivityEvent, AttemptOutcome, PlanStatus, TokenUsage } from "./types.ts";

export function claudeCodeArgs(model: string): string[] {
  return [
    "claude",
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--model",
    model,
    "--dangerously-skip-permissions",
    "-p",
    "-",
  ];
}

export function claudeVerifierArgs(model: string): string[] {
  return [
    "claude",
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--model",
    model,
    "--safe-mode",
    "--tools",
    "",
    "--disallowedTools",
    "*",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--permission-prompts",
    "none",
    "-p",
    "-",
  ];
}

export interface ClaudeInit {
  tools?: string[];
  mcpServers?: string[];
}

export interface ClaudeStreamState {
  usage: TokenUsage;
  cwd?: string;
  init?: ClaudeInit;
  plan?: PlanStatus;
  result?: {
    isError: boolean;
    subtype: string;
    text: string;
    apiErrorStatus: number | null;
  };
}

export function initialClaudeState(): ClaudeStreamState {
  return { usage: emptyUsage() };
}

export function isClaudeFinalLine(line: string): boolean {
  return parseJson(line)?.type === "result";
}

export function applyClaudeLine(state: ClaudeStreamState, line: string): ClaudeStreamState {
  const event = parseJson(line);
  if (!event) return state;

  if (event.type === "system" && event.subtype === "init") {
    return {
      ...state,
      ...(typeof event.cwd === "string" ? { cwd: event.cwd } : {}),
      init: { ...namesOf("tools", event.tools), ...namesOf("mcpServers", event.mcp_servers) },
    };
  }

  if (event.type === "rate_limit_event" && isRecord(event.rate_limit_info)) {
    return { ...state, plan: toPlanStatus(event.rate_limit_info) };
  }

  if (event.type === "result") {
    const usage = isRecord(event.usage) ? event.usage : {};
    return {
      ...state,
      usage: {
        inputTokens: state.usage.inputTokens + num(usage.input_tokens),
        cacheCreationInputTokens: state.usage.cacheCreationInputTokens + num(usage.cache_creation_input_tokens),
        cacheReadInputTokens: state.usage.cacheReadInputTokens + num(usage.cache_read_input_tokens),
        outputTokens: state.usage.outputTokens + num(usage.output_tokens),
      },
      result: {
        isError: event.is_error === true,
        subtype: typeof event.subtype === "string" ? event.subtype : "",
        text: typeof event.result === "string" ? event.result : "",
        apiErrorStatus: typeof event.api_error_status === "number" ? event.api_error_status : null,
      },
    };
  }

  return state;
}

export const claudeCodeAdapter: AgentAdapter = {
  kind: "claude-code",
  processName: "claude",
  capabilities: { readsTokenUsage: true, detectsPlanLimit: true, deniesEveryTool: true, startsInteractiveSession: true },
  command: claudeCodeArgs,
  isFinalLine: isClaudeFinalLine,
  createStream() {
    let state = initialClaudeState();
    return {
      onLine(line) {
        state = applyClaudeLine(state, line);
      },
      activity: (line) => claudeActivity(state, line),
      usage: () => state.usage,
      plan: () => state.plan,
      outcome: (supervised) => claudeOutcome(state, supervised),
    };
  },
};

const TARGET_FIELDS = ["file_path", "notebook_path", "command", "pattern", "url", "query", "skill", "description", "path"];

export function claudeActivity(state: ClaudeStreamState, line: string): ActivityEvent[] {
  const event = parseJson(line);
  if (!event) return [];

  if (event.type === "result") return [{ kind: "end", outcome: event.is_error === true ? "failed" : "completed" }];

  if (event.type !== "assistant" || !isRecord(event.message) || !Array.isArray(event.message.content)) return [];
  return event.message.content.flatMap((block: unknown): ActivityEvent[] => {
    if (!isRecord(block)) return [];
    if (block.type === "text" && typeof block.text === "string") {
      const text = firstLine(block.text);
      return text === undefined ? [] : [{ kind: "message", text }];
    }
    if (block.type === "tool_use" && typeof block.name === "string") {
      const target = toolTarget(block.input, state.cwd);
      return [{ kind: "tool", tool: block.name, ...(target !== undefined ? { target } : {}) }];
    }
    return [];
  });
}

function toolTarget(input: unknown, cwd: string | undefined): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const field of TARGET_FIELDS) {
    const value = input[field];
    if (typeof value !== "string") continue;
    const target = firstLine(cwd !== undefined && value.startsWith(`${cwd}/`) ? value.slice(cwd.length + 1) : value);
    if (target !== undefined) return target;
  }
  return undefined;
}

const PLAN_LIMIT_TEXT = /usage limit|limit reached|rate limit/i;

export function claudeOutcome(state: ClaudeStreamState, supervised: SupervisedProcess): AttemptOutcome {
  if (supervised.stopReason === "deadline") return { kind: "deadline" };
  if (supervised.stopReason === "idle-timeout") return { kind: "idle-timeout" };

  const result = state.result;
  const planRejected = state.plan?.status === "rejected";
  const limitError =
    result !== undefined &&
    result.isError &&
    (result.apiErrorStatus === 429 || PLAN_LIMIT_TEXT.test(result.text));

  if (planRejected || limitError) {
    const resetsAt = planResumeAt(state.plan);
    return {
      kind: "plan-limit",
      message: result?.text || supervised.stderrTail || "plan limit reached",
      ...(resetsAt ? { resetsAt } : {}),
    };
  }

  if (result && !result.isError && result.subtype === "success") {
    return { kind: "completed", summary: result.text };
  }

  return {
    kind: "agent-error",
    message: result?.text || supervised.stderrTail || "the agent ended with no result",
    exitCode: supervised.exitCode,
  };
}

function toPlanStatus(info: Record<string, unknown>): PlanStatus {
  const windows: PlanStatus["windows"] = {};
  if (isRecord(info.unifiedWindows)) {
    for (const [name, value] of Object.entries(info.unifiedWindows)) {
      if (isRecord(value) && typeof value.resetsAt === "number") {
        windows[name] = { utilization: num(value.utilization), resetsAt: new Date(value.resetsAt * 1000) };
      }
    }
  }
  return {
    status: typeof info.status === "string" ? info.status : "unknown",
    ...(typeof info.rateLimitType === "string" ? { limitType: info.rateLimitType } : {}),
    ...(typeof info.resetsAt === "number" ? { resetsAt: new Date(info.resetsAt * 1000) } : {}),
    windows,
  };
}

function planResumeAt(plan: PlanStatus | undefined): Date | undefined {
  if (!plan) return undefined;
  const exhausted = Object.values(plan.windows)
    .filter((w) => w.utilization >= 1)
    .map((w) => w.resetsAt)
    .sort((a, b) => b.getTime() - a.getTime());
  return exhausted[0] ?? plan.resetsAt;
}

function namesOf(key: keyof ClaudeInit, value: unknown): ClaudeInit {
  if (!Array.isArray(value)) return {};
  return { [key]: value.map((item) => (isRecord(item) && typeof item.name === "string" ? item.name : String(item))) };
}

function parseJson(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
