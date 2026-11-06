import type { AgentCard } from "./api";

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function minutes(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60000))} min`;
}

export function tokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1000) return `${Math.round(count / 1000)}k`;
  return String(count);
}

export function since(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (ms < 60_000) return "ahora";
  if (ms < 3_600_000) return `hace ${Math.round(ms / 60000)} min`;
  if (ms < 86_400_000) return `hace ${Math.round(ms / 3_600_000)} h`;
  return `hace ${Math.round(ms / 86_400_000)} d`;
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export const ROLE_LABEL: Record<AgentCard["role"], string> = { worker: "worker", verifier: "independent verifier", tester: "acceptance tester" };
export const ROLE_SHORT: Record<AgentCard["role"], string> = { worker: "worker", verifier: "verifier", tester: "tester" };

export function target(card: AgentCard): string {
  if (card.role === "tester") return "integrated verification";
  if (card.role === "verifier") return `${card.criterion} · ${card.subtask}`;
  return card.subtask ?? "";
}

export type Tone = "ok" | "warn" | "bad" | "info" | "neutral";

export function stateTone(card: AgentCard): Tone {
  if (card.state === "abandoned") return "bad";
  if (card.state === "silent") return "warn";
  if (card.state === "working") return "info";
  return card.outcome === "completed" ? "ok" : "bad";
}

export const STATE_LABEL: Record<AgentCard["state"], string> = { working: "trabajando", silent: "en silencio", abandoned: "abandonado", finished: "terminado" };

export function silence(card: AgentCard): string | null {
  if (card.state === "finished" || card.silentMs < 60_000) return null;
  if (card.state === "abandoned") return `sin actividad ${minutes(card.silentMs)} · abandonado`;
  return `en silencio ${minutes(card.silentMs)} · abandonado en ${minutes(card.abandonAfterMs - card.silentMs)}`;
}

export function runTone(status: string): Tone {
  if (status === "ready") return "ok";
  if (status === "running") return "info";
  if (status === "paused" || status === "draft") return "warn";
  if (status === "abandoned") return "bad";
  return "neutral";
}

export const RUN_LABEL: Record<string, string> = { ready: "ready", running: "en curso", draft: "draft", paused: "pausado", abandoned: "abandonado" };

export function totalTokens(card: AgentCard): number {
  return card.tokens.input + card.tokens.output;
}
