import type { RunLog } from "../coordinator/run-log.ts";
import type { AgentKind } from "../workers/types.ts";
import { clockMinutes } from "./clock-time.ts";
import type { Annotate } from "./role-menu.ts";

export interface PlanLimitReached {
  agent: AgentKind;
  resetsAt: Date;
}

export function planLimitReached(previous: RunLog | null): PlanLimitReached | null {
  if (previous === null || previous.result !== "paused" || previous.resetsAt === undefined) return null;
  const agent = previous.pauses?.at(-1)?.agent;
  const resetsAt = new Date(previous.resetsAt);
  if (agent === undefined || Number.isNaN(resetsAt.getTime())) return null;
  return { agent, resetsAt };
}

export function planLimitWarning(limit: PlanLimitReached, now: Date): string | null {
  if (now.getTime() >= limit.resetsAt.getTime()) return null;
  return `⚠ ${limit.agent} plan limit until ${clockMinutes(limit.resetsAt)}: the run will pause again`;
}

export function planLimitAnnotate(previous: RunLog | null, now: Date): Annotate {
  const limit = planLimitReached(previous);
  const warning = limit === null ? null : planLimitWarning(limit, now);
  return (entries) => {
    if (limit === null || warning === null) return {};
    const first = entries.find((entry) => entry.choice?.agent === limit.agent);
    return first === undefined ? {} : { [first.role]: [warning] };
  };
}
