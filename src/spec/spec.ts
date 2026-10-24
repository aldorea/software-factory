export type EvidenceType = "playwright" | "request" | "human";
export type VerificationLevel = "subtask" | "integration";

export interface CriterionEvidence {
  evidence: EvidenceType;
  level: VerificationLevel;
  reason?: string;
}

export interface Subtask {
  id: string;
  criteria: string[];
  scope: string[];
  dependsOn: string[];
  testChanges: string[];
}

export interface Spec {
  files: Record<string, string[]>;
  base: Subtask | null;
  subtasks: Subtask[];
  criteria: Record<string, CriterionEvidence>;
}

export type ParseResult = { ok: true; spec: Spec } | { ok: false; problems: string[] };

const BLOCK_OPEN = /^```json factory-spec[ \t]*$/;
const BLOCK_CLOSE = /^```[ \t]*$/;
const EVIDENCE_TYPES: readonly string[] = ["playwright", "request", "human"];
const LEVELS: readonly string[] = ["subtask", "integration"];

export function parseSpec(text: string): ParseResult {
  const blocks = machineBlocks(text);
  if (blocks.length !== 1) {
    return {
      ok: false,
      problems: [`the spec must hold exactly one \`\`\`json factory-spec block, found ${blocks.length}`],
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(blocks[0] ?? "");
  } catch (error) {
    return { ok: false, problems: [`the factory-spec block is not valid JSON: ${(error as Error).message}`] };
  }
  const problems: string[] = [];
  const spec = readSpec(data, problems);
  return spec && problems.length === 0 ? { ok: true, spec } : { ok: false, problems };
}

function machineBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (current === null) {
      if (BLOCK_OPEN.test(line)) current = [];
    } else if (BLOCK_CLOSE.test(line)) {
      blocks.push(current.join("\n"));
      current = null;
    } else {
      current.push(line);
    }
  }
  if (current !== null) blocks.push(current.join("\n"));
  return blocks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, where: string, problems: string[]): string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  problems.push(`${where} must be a list of strings`);
  return [];
}

function readSpec(data: unknown, problems: string[]): Spec | null {
  if (!isRecord(data)) {
    problems.push("the factory-spec block must be a JSON object");
    return null;
  }
  const files: Record<string, string[]> = {};
  if (isRecord(data.files)) {
    for (const [id, paths] of Object.entries(data.files)) files[id] = stringList(paths, `files.${id}`, problems);
  } else {
    problems.push("files must be an object from criterion ID to paths");
  }
  const base = data.base === null ? null : readSubtask(data.base, "base", problems);
  const subtasks = Array.isArray(data.subtasks)
    ? data.subtasks.map((item, index) => readSubtask(item, `subtasks[${index}]`, problems))
    : (problems.push("subtasks must be a list"), []);
  const criteria: Record<string, CriterionEvidence> = {};
  if (isRecord(data.criteria)) {
    for (const [id, value] of Object.entries(data.criteria)) {
      const evidence = readEvidence(value, `criteria.${id}`, problems);
      if (evidence) criteria[id] = evidence;
    }
  } else {
    problems.push("criteria must be an object from criterion ID to its evidence");
  }
  return { files, base, subtasks, criteria };
}

function readSubtask(value: unknown, where: string, problems: string[]): Subtask {
  if (!isRecord(value)) {
    problems.push(`${where} must be an object${where === "base" ? " or null" : ""}`);
    return { id: "", criteria: [], scope: [], dependsOn: [], testChanges: [] };
  }
  if (typeof value.id !== "string" || value.id === "") problems.push(`${where}.id must be a non-empty string`);
  return {
    id: typeof value.id === "string" ? value.id : "",
    criteria: stringList(value.criteria, `${where}.criteria`, problems),
    scope: stringList(value.scope, `${where}.scope`, problems),
    dependsOn: stringList(value.dependsOn, `${where}.dependsOn`, problems),
    testChanges: stringList(value.testChanges, `${where}.testChanges`, problems),
  };
}

function readEvidence(value: unknown, where: string, problems: string[]): CriterionEvidence | null {
  if (!isRecord(value)) {
    problems.push(`${where} must be an object`);
    return null;
  }
  const { evidence, level, reason } = value;
  if (typeof evidence !== "string" || !EVIDENCE_TYPES.includes(evidence)) {
    problems.push(`${where}.evidence must be one of ${EVIDENCE_TYPES.join(", ")}`);
    return null;
  }
  if (typeof level !== "string" || !LEVELS.includes(level)) {
    problems.push(`${where}.level must be one of ${LEVELS.join(", ")}`);
    return null;
  }
  if (reason !== undefined && typeof reason !== "string") {
    problems.push(`${where}.reason must be a string`);
    return null;
  }
  const result: CriterionEvidence = { evidence: evidence as EvidenceType, level: level as VerificationLevel };
  if (reason !== undefined) result.reason = reason;
  return result;
}

export interface ValidationContext {
  issueCriteria: string[];
  protectedPaths: string[];
}

export function validateSpec(spec: Spec, context: ValidationContext): string[] {
  const problems: string[] = [];
  const inIssue = new Set(context.issueCriteria);
  const all = spec.base ? [spec.base, ...spec.subtasks] : spec.subtasks;
  const unknown = (where: string, ids: Iterable<string>) => {
    for (const id of new Set(ids)) {
      if (!inIssue.has(id)) problems.push(`${where} names criterion ${id}, which is not in the issue`);
    }
  };
  unknown("files", Object.keys(spec.files));
  if (spec.base) unknown("the base subtask", spec.base.criteria);
  for (const subtask of spec.subtasks) unknown(`subtask ${subtask.id}`, subtask.criteria);
  unknown("criteria", Object.keys(spec.criteria));

  const held = new Set(all.flatMap((subtask) => subtask.criteria));
  for (const id of context.issueCriteria) {
    if (!held.has(id)) problems.push(`criterion ${id} is in no subtask`);
    const evidence = spec.criteria[id];
    if (!evidence) problems.push(`criterion ${id} has no evidence type`);
    else if (evidence.evidence === "human" && !evidence.reason?.trim()) {
      problems.push(`criterion ${id} is human but gives no reason`);
    }
  }

  const seen = new Set<string>();
  for (const subtask of all) {
    if (seen.has(subtask.id)) problems.push(`subtask ID ${subtask.id} is used more than once`);
    seen.add(subtask.id);
  }
  if (spec.base && spec.base.dependsOn.length > 0) problems.push("the base subtask cannot depend on another subtask");

  const ids = new Set(spec.subtasks.map((subtask) => subtask.id));
  const graph = new Map<string, string[]>();
  for (const subtask of spec.subtasks) {
    const deps = subtask.dependsOn.filter((dep) => dep !== spec.base?.id);
    for (const dep of deps) {
      if (!ids.has(dep)) problems.push(`subtask ${subtask.id} depends on ${dep}, which is not a subtask`);
    }
    graph.set(subtask.id, deps.filter((dep) => ids.has(dep)));
  }
  const reaches = (from: string, to: string) => reachable(graph, from).has(to);
  const cyclic = spec.subtasks.filter((subtask) => reaches(subtask.id, subtask.id)).map((subtask) => subtask.id);
  if (cyclic.length > 0) problems.push(`subtasks ${cyclic.join(", ")} depend on each other in a cycle`);

  for (const [index, a] of spec.subtasks.entries()) {
    for (const b of spec.subtasks.slice(index + 1)) {
      if (reaches(a.id, b.id) || reaches(b.id, a.id)) continue;
      const overlap = firstOverlap(a.scope, b.scope);
      if (overlap) {
        problems.push(
          `subtasks ${a.id} and ${b.id} could share a wave but their scope paths overlap: ${overlap[0]} and ${overlap[1]}`,
        );
      }
    }
  }

  for (const subtask of spec.subtasks) {
    for (const scope of subtask.scope) {
      for (const path of context.protectedPaths) {
        if (overlaps(scope, path)) {
          problems.push(
            `subtask ${subtask.id} has the protected path ${path} in its scope (${scope}); only the base subtask may change it`,
          );
        }
      }
    }
  }
  return problems;
}

function reachable(graph: Map<string, string[]>, from: string): Set<string> {
  const found = new Set<string>();
  const pending = [...(graph.get(from) ?? [])];
  while (pending.length > 0) {
    const next = pending.pop() as string;
    if (found.has(next)) continue;
    found.add(next);
    pending.push(...(graph.get(next) ?? []));
  }
  return found;
}

function segments(path: string): string[] {
  return path.split("/").filter((part) => part !== "" && part !== ".");
}

function overlaps(a: string, b: string): boolean {
  const left = segments(a);
  const right = segments(b);
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.every((part, index) => longer[index] === part);
}

function firstOverlap(a: string[], b: string[]): [string, string] | null {
  for (const left of a) {
    for (const right of b) {
      if (overlaps(left, right)) return [left, right];
    }
  }
  return null;
}
