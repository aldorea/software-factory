import { createContext, useContext, type ReactNode } from "react";
import { usePoll, type LiveResponse, type Polled } from "./api.ts";

const LiveData = createContext<Polled<LiveResponse>>({ data: null, failed: false, missing: false });

export function LiveProvider({ children }: { children: ReactNode }) {
  return <LiveData.Provider value={usePoll<LiveResponse>("/api/live")}>{children}</LiveData.Provider>;
}

export function useLive(): Polled<LiveResponse> {
  return useContext(LiveData);
}
