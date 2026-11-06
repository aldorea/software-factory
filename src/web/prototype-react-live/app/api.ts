import { useEffect, useRef, useState } from "react";
import type { AgentCard, LiveResponse, RunDetail, RunRow } from "../live-data.ts";
import type { RunStats } from "../../../coordinator/stats.ts";

export type { AgentCard, LiveResponse, RunDetail, RunRow, RunStats };
export type LiveRun = LiveResponse["runs"][number];

export const POLL_MS = 2000;

export interface Polled<T> {
  data: T | null;
  polling: boolean;
  fetchedAt: number | null;
  error: string | null;
}

export function usePoll<T>(url: string, keepPolling: (data: T) => boolean): Polled<T> {
  const [state, setState] = useState<Polled<T>>({ data: null, polling: true, fetchedAt: null, error: null });
  const keep = useRef(keepPolling);
  keep.current = keepPolling;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    const tick = async () => {
      try {
        const response = await fetch(url);
        const data = (await response.json()) as T;
        if (!alive) return;
        const again = response.ok && keep.current(data);
        setState({ data, polling: again, fetchedAt: Date.now(), error: response.ok ? null : `HTTP ${response.status}` });
        if (again) timer = setTimeout(tick, POLL_MS);
      } catch (error) {
        if (!alive) return;
        setState((previous) => ({ ...previous, polling: true, error: String(error) }));
        timer = setTimeout(tick, POLL_MS);
      }
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [url]);
  return state;
}

export const useLive = () => usePoll<LiveResponse>("/api/live", (data) => data.inProgress);
export const useRuns = () => usePoll<{ rows: RunRow[]; stats: RunStats }>("/api/runs", (data) => data.rows.some((row) => row.status === "running"));
export const useRun = (runId: string) => usePoll<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`, (data) => data.row.status === "running");
