import { ID_PLACEHOLDER, type EvidenceCommands } from "../config/config.ts";
import type { CriterionEvidence, Spec } from "../spec/spec.ts";

export interface CriterionPlan {
  id: string;
  evidence: "playwright" | "request";
  command: string;
}

export interface HumanPlan {
  id: string;
  reason: string;
}

export interface EvidencePlan {
  criteria: CriterionPlan[];
  human: HumanPlan[];
}

const CRITERION_ID = /^A[0-9]+$/;

export function evidenceCommand(template: string, id: string): string {
  if (!CRITERION_ID.test(id)) throw new Error(`${JSON.stringify(id)} is not a criterion ID, so it cannot go into an evidence command`);
  return template.split(ID_PLACEHOLDER).join(id);
}

export function evidenceProblems(spec: Spec, commands: EvidenceCommands): string[] {
  const problems: string[] = [];
  for (const [id, criterion] of Object.entries(spec.criteria)) {
    if (criterion.evidence !== "human" && !CRITERION_ID.test(id)) problems.push(`${JSON.stringify(id)} is not a criterion ID`);
    else if (criterion.evidence !== "human" && commands[criterion.evidence] === undefined) {
      problems.push(
        `criterion ${id} has ${criterion.evidence} evidence but .factory/config.ts gives no evidence.${criterion.evidence} command`,
      );
    }
  }
  return problems;
}

export function gatePlan(spec: Spec, subtaskCriteria: string[], commands: EvidenceCommands): EvidencePlan {
  return {
    criteria: planned(spec, subtaskCriteria, commands, (criterion) => criterion.level === "subtask"),
    human: [],
  };
}

export function integrationPlan(spec: Spec, commands: EvidenceCommands): EvidencePlan {
  const ids = Object.keys(spec.criteria);
  const human = ids.flatMap((id) => {
    const criterion = spec.criteria[id];
    return criterion?.evidence === "human" ? [{ id, reason: criterion.reason ?? "" }] : [];
  });
  return { criteria: planned(spec, ids, commands, () => true), human };
}

function planned(
  spec: Spec,
  ids: string[],
  commands: EvidenceCommands,
  include: (criterion: CriterionEvidence) => boolean,
): CriterionPlan[] {
  return ids.flatMap((id) => {
    const criterion = spec.criteria[id];
    if (criterion === undefined || criterion.evidence === "human" || !include(criterion)) return [];
    const template = commands[criterion.evidence];
    if (template === undefined) throw new Error(`no evidence.${criterion.evidence} command for criterion ${id}`);
    return [{ id, evidence: criterion.evidence, command: evidenceCommand(template, id) }];
  });
}
