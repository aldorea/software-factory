import { firstLine, toolTarget } from "./activity.ts";
import { emptyUsage, type AgentAdapter } from "./agent-adapter.ts";
import { turnRequestProblem, type AllowedTool, type RefinementTurn, type TurnCheck, type TurnMessage, type TurnRequest } from "./refinement-turn.ts";
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
  refinementTurn: {
    command: claudeTurnCommand,
    checker: claudeTurnChecker,
    transcript: claudeTurnTranscript,
  },
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

export const CLAUDE_TURN_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "Bash"];

export function claudeAllowedRules(tools: readonly AllowedTool[]): string[] {
  return tools.flatMap((tool) => {
    if (tool.kind === "read") return [`Read(/${tool.path}/**)`];
    if (tool.kind === "edit") return [`Edit(/${tool.path}/**)`];
    return tool.more ? [`Bash(${tool.text})`, `Bash(${tool.text} *)`] : [`Bash(${tool.text})`];
  });
}

function claudeTurnCommand(request: TurnRequest): ReturnType<RefinementTurn["command"]> {
  const problem = turnRequestProblem(request);
  if (problem !== null) return { ok: false, problem };
  const { place, session } = request;
  return {
    ok: true,
    args: [
      "--verbose",
      "--output-format",
      "stream-json",
      "--model",
      request.model,
      "--plugin-dir",
      place.pluginDir,
      "--permission-mode",
      "default",
      "--strict-mcp-config",
      "--tools",
      CLAUDE_TURN_TOOLS.join(","),
      "--allowedTools",
      ...claudeAllowedRules(request.allowedTools),
      ...(session === null ? [] : ["--resume", session]),
      "-p",
      session === null ? `/factory:refine ${place.issue}` : "-",
    ],
    env: { FACTORY_CLI: place.factoryCli },
    readsAnswer: session !== null,
  };
}

function claudeTurnChecker() {
  let decided: TurnCheck | null = null;
  return {
    onLine(line: string): TurnCheck {
      if (decided !== null) return decided;
      const event = parseJson(line);
      if (event === undefined) return { kind: "waiting" };
      if (event.type === "system" && event.subtype === "init") {
        decided = initCheck(event);
        return decided;
      }
      if (event.type === "assistant" || event.type === "user" || event.type === "result") {
        decided = {
          kind: "refused",
          problem: "the agent of the refinement acted before it reported its tools, so the allowed tools cannot be checked",
        };
        return decided;
      }
      return { kind: "waiting" };
    },
  };
}

function initCheck(event: Record<string, unknown>): TurnCheck {
  const { tools, mcpServers } = { ...namesOf("tools", event.tools), ...namesOf("mcpServers", event.mcp_servers) };
  if (tools === undefined || mcpServers === undefined) {
    return { kind: "refused", problem: "the agent of the refinement did not report its tools, so the allowed tools cannot be checked" };
  }
  const sameTools = tools.length === CLAUDE_TURN_TOOLS.length && CLAUDE_TURN_TOOLS.every((tool) => tools.includes(tool));
  if (!sameTools) {
    return {
      kind: "refused",
      problem: `the agent of the refinement did not load the allowed tools: it reported ${tools.length === 0 ? "no tools" : tools.join(", ")} instead of ${CLAUDE_TURN_TOOLS.join(", ")}`,
    };
  }
  if (mcpServers.length > 0) {
    return { kind: "refused", problem: `the agent of the refinement loaded MCP servers outside the allowed tools: ${mcpServers.join(", ")}` };
  }
  if (event.permissionMode !== "default") {
    return { kind: "refused", problem: `the agent of the refinement runs in the permission mode ${String(event.permissionMode)}, not default` };
  }
  if (typeof event.session_id !== "string") {
    return { kind: "refused", problem: "the agent of the refinement reported no session" };
  }
  return { kind: "loaded", session: event.session_id };
}

function claudeTurnTranscript(lines: readonly string[]): TurnMessage[] {
  let cwd: string | undefined;
  return lines.flatMap((line): TurnMessage[] => {
    const event = parseJson(line);
    if (event === undefined) return [];
    if (event.type === "system" && event.subtype === "init" && typeof event.cwd === "string") cwd = event.cwd;
    if (event.type === "result") return [{ kind: "end", text: event.is_error === true ? "failed" : "completed" }];
    if (event.type !== "assistant" || !isRecord(event.message) || !Array.isArray(event.message.content)) return [];
    return event.message.content.flatMap((block: unknown): TurnMessage[] => {
      if (!isRecord(block)) return [];
      if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") return [{ kind: "text", text: block.text }];
      if (block.type === "tool_use" && typeof block.name === "string") {
        const target = toolTarget(block.input, cwd);
        return [{ kind: "tool", text: target === undefined ? block.name : `${block.name} ${target}` }];
      }
      return [];
    });
  });
}

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

export function claudeMessagesUsage(lines: readonly string[]): TokenUsage | null {
  const byMessage = new Map<string, Record<string, unknown>>();
  for (const line of lines) {
    const event = parseJson(line);
    if (event?.type !== "assistant" || !isRecord(event.message) || !isRecord(event.message.usage)) continue;
    const id = typeof event.message.id === "string" ? event.message.id : `line-${byMessage.size}`;
    byMessage.set(id, event.message.usage);
  }
  if (byMessage.size === 0) return null;
  return [...byMessage.values()].reduce<TokenUsage>(
    (total, usage) => ({
      inputTokens: total.inputTokens + num(usage.input_tokens),
      cacheCreationInputTokens: total.cacheCreationInputTokens + num(usage.cache_creation_input_tokens),
      cacheReadInputTokens: total.cacheReadInputTokens + num(usage.cache_read_input_tokens),
      outputTokens: total.outputTokens + num(usage.output_tokens),
    }),
    emptyUsage(),
  );
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
