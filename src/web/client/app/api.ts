import { createContext, useContext, useEffect, useState } from "react";

export type { PullRequestCell, RunRow, RunsResponse } from "../../api.ts";
export type { RunStats } from "../../../coordinator/stats.ts";
export type { RunStatus } from "../../../coordinator/abandoned.ts";
export type {
  AttemptView,
  CheckView,
  CriterionView,
  EvidenceFileView,
  GateView,
  RunBlockView,
  RunDetail,
  SubtaskView,
  TesterView,
  VerificationView,
} from "../../run-detail.ts";
export type { NextStep, RunCause } from "../../run-causes.ts";
export type { RunStep, StepState } from "../../run-steps.ts";
export type { AgentState, LiveAgent, LiveEvent, LiveResponse, LiveRole, LiveRun } from "../../live.ts";
export type { WebActionView } from "../../web-action-view.ts";
export type { WebActionsList } from "../../actions-api.ts";
export type { RunForm, RunFormRole } from "../../run-form.ts";
export type { ActionRequest } from "../../action-args.ts";
export type { AuthAgent, AuthPage } from "../../auth-api.ts";
export type { RefinementConversation, RefinementTurnView } from "../../refinement-api.ts";
export type { TurnMessage } from "../../../workers/refinement-turn.ts";

export const POLL_MS = 2000;
export const IDLE_POLL_MS = 15_000;

export const ApiOrigin = createContext("");

export const IdlePollMs = createContext(IDLE_POLL_MS);

export interface Polled<T> {
  data: T | null;
  failed: boolean;
  missing: boolean;
}

export function usePoll<T extends { inProgress: boolean }>(path: string): Polled<T> {
  const origin = useContext(ApiOrigin);
  const idleMs = useContext(IdlePollMs);
  const [state, setState] = useState<Polled<T>>({ data: null, failed: false, missing: false });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        const response = await fetch(`${origin}${path}`);
        if (response.status === 404) {
          if (alive) setState({ data: null, failed: false, missing: true });
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as T;
        if (!alive) return;
        setState({ data, failed: false, missing: false });
        timer = setTimeout(tick, data.inProgress ? POLL_MS : idleMs);
      } catch {
        if (!alive) return;
        setState((previous) => ({ ...previous, failed: true }));
        timer = setTimeout(tick, POLL_MS);
      }
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [origin, path, idleMs]);
  return state;
}
