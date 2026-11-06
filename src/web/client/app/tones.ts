import type { Tone } from "./components/ui/badge.tsx";
import type { AgentState, RunStatus, SubtaskView } from "./api.ts";

const RUN_STATUS_TONE: Record<RunStatus, Tone> = {
  ready: "ok",
  draft: "warn",
  abandoned: "warn",
  paused: "info",
  running: "info",
};

const AGENT_STATE_TONE: Record<AgentState, Tone> = {
  working: "info",
  silent: "warn",
  abandoned: "bad",
  ended: "neutral",
};

const SUBTASK_STATE_TONE: Record<SubtaskView["state"], Tone> = {
  pending: "neutral",
  "not-started": "neutral",
  working: "info",
  gating: "info",
  merged: "ok",
  blocked: "bad",
  interrupted: "warn",
};

const AGENT_STATE_EDGE: Record<AgentState, string> = {
  working: "border-t-info",
  silent: "border-t-warn",
  abandoned: "border-t-bad",
  ended: "border-t-border",
};

const AGENT_STATE_TEXT: Record<AgentState, string> = {
  working: "",
  silent: "text-warn",
  abandoned: "text-bad",
  ended: "",
};

const AGENT_STATE_BAR: Record<AgentState, string> = {
  working: "bg-ok",
  silent: "bg-warn",
  abandoned: "bg-bad",
  ended: "bg-muted-foreground",
};

function own<T>(map: Record<string, T>, key: string, fallback: T): T {
  return Object.hasOwn(map, key) ? (map[key] as T) : fallback;
}

export function runStatusTone(status: string): Tone {
  return own(RUN_STATUS_TONE, status, "neutral");
}

export function agentStateTone(state: string): Tone {
  return own(AGENT_STATE_TONE, state, "neutral");
}

export function subtaskStateTone(state: string): Tone {
  return own(SUBTASK_STATE_TONE, state, "neutral");
}

export function agentStateEdge(state: string): string {
  return own(AGENT_STATE_EDGE, state, "border-t-border");
}

export function agentStateText(state: string): string {
  return own(AGENT_STATE_TEXT, state, "");
}

export function agentStateBar(state: string): string {
  return own(AGENT_STATE_BAR, state, "bg-muted-foreground");
}

export function succeededTone(succeeded: boolean | null): Tone {
  if (succeeded === null) return "info";
  return succeeded ? "ok" : "bad";
}
