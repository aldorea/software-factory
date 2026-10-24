import { firstOverlap, type Spec, type Subtask } from "../spec/spec.ts";
import type { SubtaskState } from "./run-log.ts";

export interface Schedule {
  base: Subtask | null;
  waves: Subtask[][];
}

export function schedule(spec: Spec): Schedule {
  const baseId = spec.base?.id;
  const placed = new Set<string>();
  const waves: Subtask[][] = [];
  let remaining = spec.subtasks;
  while (remaining.length > 0) {
    const wave: Subtask[] = [];
    for (const candidate of remaining) {
      const ready = candidate.dependsOn.every((dep) => dep === baseId || placed.has(dep));
      const free = wave.every((member) => firstOverlap(member.scope, candidate.scope) === null);
      if (ready && free) wave.push(candidate);
    }
    if (wave.length === 0) {
      throw new Error(`cannot be scheduled: ${remaining.map((item) => item.id).join(", ")} depend on each other in a cycle`);
    }
    for (const member of wave) placed.add(member.id);
    remaining = remaining.filter((item) => !placed.has(item.id));
    waves.push(wave);
  }
  return { base: spec.base, waves };
}

const UNMET_STATE: Partial<Record<SubtaskState, string>> = {
  blocked: "is blocked",
  interrupted: "was interrupted",
};

export function dependencyProblem(subtask: Subtask, states: ReadonlyMap<string, SubtaskState>): string | null {
  const unmet = subtask.dependsOn.flatMap((dep) => {
    const state = states.get(dep);
    if (state === undefined || state === "merged") return [];
    return [`${dep}, which ${UNMET_STATE[state] ?? "did not start"}`];
  });
  if (unmet.length === 0) return null;
  return `It depends on ${unmet.join(", and ")}.`;
}
