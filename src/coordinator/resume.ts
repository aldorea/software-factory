import type { Role, RoleChoice } from "../config/config.ts";
import type { AgentChangeRecord, RunLog, SubtaskRecord } from "./run-log.ts";

export function resumeDefaults(
  previous: RunLog | null,
  configured: Partial<Record<Role, RoleChoice>>,
): Partial<Record<Role, RoleChoice>> {
  if (previous === null || previous.result !== "paused") return configured;
  const verifier = previous.agents.verifier ?? configured.verifier;
  const tester = previous.agents.tester ?? configured.tester;
  return {
    workers: previous.agents.workers,
    ...(verifier !== undefined ? { verifier } : {}),
    ...(tester !== undefined ? { tester } : {}),
  };
}

export function defaultOrigin(previous: RunLog | null, role: Role): "config" | "paused run" {
  if (previous === null || previous.result !== "paused") return "config";
  return role === "workers" || previous.agents[role] !== undefined ? "paused run" : "config";
}

export interface ResumeInput {
  fresh: RunLog;
  previous: RunLog | null;
  merged: ReadonlySet<string>;
  now: Date;
}

export const MERGED_EARLIER = "Merged into the integration branch by an earlier run.";

export function resumedLog({ fresh, previous, merged, now }: ResumeInput): RunLog {
  if (previous === null || previous.result !== "paused") {
    return {
      ...fresh,
      subtasks: fresh.subtasks.map((record) =>
        merged.has(record.id) ? { ...record, state: "merged", reason: MERGED_EARLIER } : record,
      ),
    };
  }
  const earlier = new Map(previous.subtasks.map((record) => [record.id, record]));
  const pausedAt = Date.parse(previous.endedAt ?? now.toISOString());
  const {
    endedAt: _endedAt,
    pauseReason: _pauseReason,
    resetsAt: _resetsAt,
    verification: _verification,
    ...kept
  } = previous;
  return {
    ...kept,
    result: "running",
    agents: {
      workers: fresh.agents.workers,
      ...(fresh.agents.verifier !== undefined ? { verifier: fresh.agents.verifier } : {}),
      ...(fresh.agents.tester !== undefined ? { tester: fresh.agents.tester } : {}),
      changes: [...previous.agents.changes, ...agentChanges(previous, fresh, now)],
    },
    cost: { ...previous.cost, pausedMs: previous.cost.pausedMs + Math.max(0, now.getTime() - pausedAt) },
    subtasks: fresh.subtasks.map((record) => continued(record, earlier.get(record.id), merged.has(record.id))),
  };
}

function continued(fresh: SubtaskRecord, earlier: SubtaskRecord | undefined, merged: boolean): SubtaskRecord {
  if (earlier === undefined) return merged ? { ...fresh, state: "merged", reason: MERGED_EARLIER } : fresh;
  if (earlier.state === "blocked" && !merged) return { ...earlier, criteria: fresh.criteria, branch: fresh.branch };
  const {
    reason: _reason,
    block: _block,
    blockType: _blockType,
    conflictFiles: _conflictFiles,
    ...kept
  } = earlier;
  const attempts = kept.attempts.filter((attempt) => attempt.outcome !== "running");
  if (merged) return { ...kept, attempts, criteria: fresh.criteria, branch: fresh.branch, state: "merged" };
  return { ...kept, attempts, criteria: fresh.criteria, branch: fresh.branch, state: "pending" };
}

function agentChanges(previous: RunLog, fresh: RunLog, now: Date): AgentChangeRecord[] {
  const changes: AgentChangeRecord[] = [];
  const at = now.toISOString();
  const same = (a: { agent: string; model: string }, b: { agent: string; model: string }) => a.agent === b.agent && a.model === b.model;
  if (!same(previous.agents.workers, fresh.agents.workers)) {
    changes.push({ role: "workers", from: previous.agents.workers, to: fresh.agents.workers, at });
  }
  for (const role of ["verifier", "tester"] as const) {
    const before = previous.agents[role];
    const after = fresh.agents[role];
    if (before !== undefined && after !== undefined && !same(before, after)) changes.push({ role, from: before, to: after, at });
  }
  return changes;
}
