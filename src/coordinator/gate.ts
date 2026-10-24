import type { Spec } from "../spec/spec.ts";
import type { CheckRecord, CriterionRecord } from "./run-log.ts";

export const ALWAYS_PROTECTED = [".factory"];

export type ChangeStatus = "added" | "modified" | "deleted";

export interface DiffChange {
  path: string;
  status: ChangeStatus;
}

export type RejectionKind = "protected" | "request-check" | "existing-test" | "scope" | "check" | "criterion" | "verifier";

type DiffRejectionKind = Exclude<RejectionKind, "check" | "criterion" | "verifier">;

export interface GateRejection {
  kind: RejectionKind;
  message: string;
  signature: string;
}

export interface GateInput {
  changes: DiffChange[];
  scope: string[];
  protectedPaths: string[];
  isBase: boolean;
  existingTestPaths: ReadonlySet<string>;
  authorizedTestChanges: string[];
  requestCheckPaths: string[];
  checks: CheckRecord[];
  criteria?: CriterionRecord[];
}

export interface GateDecision {
  accepted: boolean;
  reasons: string[];
  rejections: GateRejection[];
  signature: string;
}

export function gateDecision(input: GateInput): GateDecision {
  const rejections = [
    ...diffRejections(input),
    ...input.checks.filter((check) => !check.passed).map(checkRejection),
    ...(input.criteria ?? []).filter((criterion) => !criterion.passed).map(criterionRejection),
  ];
  return {
    accepted: rejections.length === 0,
    reasons: rejections.map((rejection) => rejection.message),
    rejections,
    signature: rejections.map((rejection) => rejection.signature).join(" | "),
  };
}

function diffRejections(input: GateInput): GateRejection[] {
  const protectedPaths = input.isBase ? [] : [...input.protectedPaths, ...ALWAYS_PROTECTED];
  const requestChecks = input.isBase ? [] : input.requestCheckPaths;
  const found: Record<DiffRejectionKind, string[]> = {
    protected: [],
    "request-check": [],
    "existing-test": [],
    scope: [],
  };
  for (const { path } of input.changes) {
    const authorized = input.authorizedTestChanges.some((entry) => covers(entry, path));
    if (protectedPaths.some((entry) => covers(entry, path))) found.protected.push(path);
    else if (requestChecks.some((entry) => covers(entry, path))) found["request-check"].push(path);
    else if (input.existingTestPaths.has(path) && !authorized) found["existing-test"].push(path);
    else if (!authorized && !input.scope.some((entry) => covers(entry, path))) found.scope.push(path);
  }
  const rejections: GateRejection[] = [];
  const add = (kind: DiffRejectionKind, paths: string[], message: string) => {
    if (paths.length === 0) return;
    const sorted = [...paths].sort();
    rejections.push({ kind, message: `${message}: ${sorted.join(", ")}`, signature: `${kind}:${sorted.join(",")}` });
  };
  add("protected", found.protected, "it touches protected paths");
  add("request-check", found["request-check"], "it changes request checks, which only the base subtask writes");
  add("existing-test", found["existing-test"], "it changes existing tests that the spec does not authorize");
  add("scope", found.scope, `it touches paths outside its scope (${input.scope.join(", ")})`);
  return rejections;
}

function checkRejection(check: CheckRecord): GateRejection {
  const detail = check.firstError ? `: ${check.firstError}` : "";
  return {
    kind: "check",
    message: `check ${check.name} failed with exit code ${check.exitCode}${detail}`,
    signature: `check:${check.name}${detail}`,
  };
}

function criterionRejection(criterion: CriterionRecord): GateRejection {
  return {
    kind: "criterion",
    message: `criterion ${criterion.id} (${criterion.evidence}) failed with exit code ${criterion.exitCode}`,
    signature: `criterion:${criterion.id}`,
  };
}

function segments(path: string): string[] {
  return path.split("/").filter((part) => part !== "" && part !== ".");
}

export function covers(entry: string, path: string): boolean {
  const head = segments(entry);
  const target = segments(path);
  return head.length <= target.length && head.every((part, index) => target[index] === part);
}

const TEST_FOLDERS = new Set(["test", "tests", "__tests__", "e2e"]);

export function isTestFile(path: string): boolean {
  const parts = segments(path);
  const name = parts.at(-1) ?? "";
  return /\.(test|spec)\.[^.]+$/.test(name) || parts.slice(0, -1).some((part) => TEST_FOLDERS.has(part));
}

export function requestCheckPaths(spec: Spec): string[] {
  return Object.entries(spec.files)
    .filter(([id]) => spec.criteria[id]?.evidence === "request")
    .flatMap(([, paths]) => paths.filter(isTestFile));
}
