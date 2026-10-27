import { isAbsolute, normalize, relative } from "node:path";

export interface TesterVerdict {
  id: string;
  passed: boolean;
  observation: string;
  evidence: string[];
}

export type ParsedTesterReport = { ok: true; verdicts: TesterVerdict[] } | { ok: false; problem: string };

export interface ReportExpectation {
  ids: string[];
  evidenceDir: string;
}

const JSON_BLOCK = /```json[^\n]*\n([\s\S]*?)```/g;

export function parseTesterReport(text: string, expected: ReportExpectation): ParsedTesterReport {
  const block = [...text.matchAll(JSON_BLOCK)].at(-1)?.[1];
  if (block === undefined) return { ok: false, problem: "the report has no json block" };
  let data: unknown;
  try {
    data = JSON.parse(block);
  } catch (error) {
    return { ok: false, problem: `the json block of the report is not valid JSON: ${(error as Error).message}` };
  }
  const entries = isRecord(data) && Array.isArray(data.criteria) ? data.criteria : null;
  if (entries === null) return { ok: false, problem: "the json block of the report must be an object with a criteria list" };

  const problems: string[] = [];
  const verdicts = new Map<string, TesterVerdict>();
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = isRecord(entry) && typeof entry.id === "string" ? entry.id : null;
    if (id === null) {
      problems.push("each criterion of the report must have an id");
      continue;
    }
    if (!expected.ids.includes(id)) {
      problems.push(`the report gives a verdict for ${id}, which it was not asked`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`the report gives ${id} more than one verdict`);
      continue;
    }
    seen.add(id);
    const verdict = verdictOf(id, entry as Record<string, unknown>, expected.evidenceDir, problems);
    if (verdict !== null) verdicts.set(id, verdict);
  }
  for (const id of expected.ids) {
    if (!seen.has(id)) problems.push(`the report gives no verdict for ${id}`);
  }
  if (problems.length > 0) return { ok: false, problem: problems.join("; ") };
  return { ok: true, verdicts: expected.ids.map((id) => verdicts.get(id) as TesterVerdict) };
}

function verdictOf(id: string, entry: Record<string, unknown>, evidenceDir: string, problems: string[]): TesterVerdict | null {
  const before = problems.length;
  if (entry.verdict !== "pass" && entry.verdict !== "fail") problems.push(`${id} must have the verdict pass or fail`);
  const observation = typeof entry.observation === "string" ? entry.observation.trim() : "";
  if (observation === "") problems.push(`${id} must say what the tester did and saw`);
  const listed = Array.isArray(entry.evidence) ? entry.evidence : [];
  if (listed.length === 0 || !listed.every((path) => typeof path === "string")) {
    problems.push(`${id} must list at least one file of evidence`);
  }
  const evidence: string[] = [];
  for (const path of listed as string[]) {
    const inside = insideFolder(path, evidenceDir);
    if (inside === null) problems.push(`the evidence ${path} of ${id} is outside the evidence folder`);
    else evidence.push(inside);
  }
  if (problems.length > before) return null;
  return { id, passed: entry.verdict === "pass", observation, evidence };
}

function insideFolder(path: string, folder: string): string | null {
  const inside = isAbsolute(path) ? relative(folder, path) : normalize(path);
  if (inside === "" || inside === "." || isAbsolute(inside) || inside.split("/").includes("..")) return null;
  return inside;
}

export function evidenceProblem(verdicts: TesterVerdict[], files: ReadonlySet<string>): string | null {
  for (const verdict of verdicts) {
    const missing = verdict.evidence.find((path) => !files.has(path));
    if (missing !== undefined) return `the evidence ${missing} of ${verdict.id} does not exist`;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
