import type { MergeOutcome } from "../git/repo.ts";
import type { Subtask } from "../spec/spec.ts";
import type { BlockRecord, BlockType, FollowUpRecord, SubtaskRecord, SubtaskState } from "./run-log.ts";
import { dependencyProblem, type Schedule } from "./schedule.ts";
import type { WaveScope } from "./scope-extension.ts";
import type { LoopResult, PlanLimitHit } from "./subtask-loop.ts";

export type FollowUpOutcome = FollowUpRecord["outcome"];

export type LoopSettlement =
  | { kind: "merge" }
  | { kind: "interrupted"; reason: string }
  | { kind: "blocked"; block: BlockRecord }
  | { kind: "paused"; limit?: PlanLimitHit };

export const INTERRUPTED_IN_ATTEMPT = "A failure of the worker layer stopped it before its attempt ended.";
export const INTERRUPTED_IN_GATE = "A failure of the worker layer stopped its gate.";

export function settleLoop(loop: LoopResult | null): LoopSettlement {
  if (loop === null) return { kind: "interrupted", reason: INTERRUPTED_IN_ATTEMPT };
  switch (loop.kind) {
    case "accepted":
      return { kind: "merge" };
    case "interrupted":
      return { kind: "interrupted", reason: INTERRUPTED_IN_GATE };
    case "reported":
      return { kind: "blocked", block: { type: loop.type, reason: loop.reason } };
    case "paused":
      return loop.limit === undefined ? { kind: "paused" } : { kind: "paused", limit: loop.limit };
    case "blocked":
      return {
        kind: "blocked",
        block: {
          type: loop.stop.type,
          reason: loop.stop.reason,
          ...(loop.lastFailure !== undefined ? { lastFailure: loop.lastFailure } : {}),
        },
      };
  }
}

export function applySettlement(
  record: SubtaskRecord,
  settlement: Exclude<LoopSettlement, { kind: "merge" }>,
  followUp: boolean,
): FollowUpOutcome {
  if (settlement.kind === "interrupted") {
    record.state = "interrupted";
    record.reason = settlement.reason;
    return "interrupted";
  }
  if (settlement.kind === "blocked") {
    blockSubtask(record, settlement.block);
    return "blocked";
  }
  if (followUp) record.state = "merged";
  return "paused";
}

export function applyMerge(record: SubtaskRecord, merged: MergeOutcome, integrationBranch: string): FollowUpOutcome {
  if (merged.kind === "merged") {
    record.state = "merged";
    return "merged";
  }
  record.conflicts += 1;
  record.conflictFiles = merged.files;
  record.state = "blocked";
  record.reason = `Its merge into ${integrationBranch} conflicts in ${merged.files.join(", ")}.`;
  return "blocked";
}

export function blockSubtask(record: SubtaskRecord, block: BlockRecord): void {
  record.state = "blocked";
  record.blockType = blockTypeOf(block.type);
  record.reason = block.reason;
  record.block = block;
}

export function blockTypeOf(type: BlockRecord["type"]): BlockType {
  if (type === "scope" || type === "design-question" || type === "patience") return type;
  return "limit";
}

export interface NotStartedInput {
  subtask: Subtask;
  baseId: string | null;
  states: ReadonlyMap<string, SubtaskState>;
  conflicted: boolean;
}

export function notStartedReason({ subtask, baseId, states, conflicted }: NotStartedInput): string | null {
  if (baseId !== null && subtask.id !== baseId && states.get(baseId) !== "merged") {
    return `It did not start because the base subtask ${baseId} is blocked.`;
  }
  if (conflicted) return "It did not start because the run stopped on a merge conflict.";
  return dependencyProblem(subtask, states);
}

export function waveScopes(plan: Schedule, subtaskId: string, scopes: ReadonlyMap<string, string[]>): WaveScope[] {
  const wave = plan.waves.find((members) => members.some((member) => member.id === subtaskId)) ?? [];
  return wave
    .filter((member) => member.id !== subtaskId)
    .map((member) => ({ subtask: member.id, scope: entryOf(scopes, member.id, "scope") }));
}

export function entryOf<T>(entries: ReadonlyMap<string, T>, subtaskId: string, what: string): T {
  const entry = entries.get(subtaskId);
  if (entry === undefined) throw new Error(`the run has no ${what} of subtask ${subtaskId}`);
  return entry;
}
