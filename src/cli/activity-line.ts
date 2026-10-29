import type { ActivityEntry } from "../coordinator/ports.ts";
import type { ActivityEvent } from "../workers/types.ts";
import { clockTime } from "./clock-time.ts";

export function activityLine(entry: ActivityEntry): string {
  return `${clockTime(entry.at)} ${entry.source} · ${describeActivity(entry.event)}`;
}

export function describeActivity(event: ActivityEvent): string {
  if (event.kind === "message") return `"${event.text}"`;
  if (event.kind === "tool") return event.target === undefined ? event.tool : `${event.tool} ${event.target}`;
  return event.outcome === "completed" ? "attempt ended" : "attempt failed";
}
