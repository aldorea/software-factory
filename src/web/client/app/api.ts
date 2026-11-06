import { createContext, useContext, useEffect, useState } from "react";

export type { PullRequestCell, RunRow, RunsResponse } from "../../api.ts";
export type { RunStats } from "../../../coordinator/stats.ts";
export type { RunStatus } from "../../../coordinator/abandoned.ts";

export const POLL_MS = 2000;

export const ApiOrigin = createContext("");

export interface Polled<T> {
  data: T | null;
  failed: boolean;
}

export function usePoll<T extends { inProgress: boolean }>(path: string): Polled<T> {
  const origin = useContext(ApiOrigin);
  const [state, setState] = useState<Polled<T>>({ data: null, failed: false });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        const response = await fetch(`${origin}${path}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as T;
        if (!alive) return;
        setState({ data, failed: false });
        if (data.inProgress) timer = setTimeout(tick, POLL_MS);
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
  }, [origin, path]);
  return state;
}
