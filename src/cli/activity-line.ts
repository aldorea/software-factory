import type { ActivityEntry } from "../coordinator/ports.ts";
import type { ActivityEvent } from "../workers/types.ts";

export function activityLine(entry: ActivityEntry): string {
  return `${clockTime(entry.at)} ${entry.source} · ${describe(entry.event)}`;
}

function clockTime(at: Date): string {
  return [at.getHours(), at.getMinutes(), at.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}

function describe(event: ActivityEvent): string {
  if (event.kind === "message") return `"${event.text}"`;
  if (event.kind === "tool") return event.target === undefined ? event.tool : `${event.tool} ${event.target}`;
  return event.outcome === "completed" ? "attempt ended" : "attempt failed";
}
