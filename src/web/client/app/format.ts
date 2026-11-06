import type { Tone } from "./components/ui/badge.tsx";
import type { RunStatus } from "./api.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(then: string, now: string): string {
  const elapsed = Math.max(0, Date.parse(now) - Date.parse(then));
  if (elapsed < MINUTE) return "hace un momento";
  if (elapsed < HOUR) return `hace ${Math.floor(elapsed / MINUTE)} min`;
  if (elapsed < DAY) return `hace ${Math.floor(elapsed / HOUR)} h`;
  return `hace ${Math.floor(elapsed / DAY)} d`;
}

export function duration(ms: number): string {
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 1) return `${Math.round(ms / 1000)} s`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export const STATUS_TONE: Record<RunStatus, Tone> = {
  ready: "ok",
  draft: "warn",
  abandoned: "warn",
  paused: "info",
  running: "info",
};

const TONES = new Map<string, Tone>([
  ["ready", "ok"],
  ["merged", "ok"],
  ["pasa", "ok"],
  ["aceptado", "ok"],
  ["accept", "ok"],
  ["draft", "warn"],
  ["interrupted", "warn"],
  ["abandoned", "warn"],
  ["paused", "info"],
  ["running", "info"],
  ["working", "info"],
  ["gating", "info"],
  ["blocked", "bad"],
  ["falla", "bad"],
  ["rechazado", "bad"],
  ["refute", "bad"],
  ["error", "bad"],
]);

export function toneOf(value: string): Tone {
  return TONES.get(value) ?? "neutral";
}
