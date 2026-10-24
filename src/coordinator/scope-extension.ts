import { covers } from "./gate.ts";

export interface WaveScope {
  subtask: string;
  scope: string[];
}

export interface ScopeExtensionInput {
  requested: string[];
  scope: string[];
  waveScopes: WaveScope[];
  protectedPaths: string[];
  existingTestPaths: ReadonlySet<string>;
  authorizedTestChanges: string[];
  requestCheckPaths: string[];
}

export type ScopeExtensionDecision =
  | { kind: "extend"; paths: string[] }
  | { kind: "covered"; paths: string[] }
  | { kind: "block"; reason: string };

export function decideScopeExtension(input: ScopeExtensionInput): ScopeExtensionDecision {
  const refusals: string[] = [];
  const covered: string[] = [];
  const free: string[] = [];
  for (const request of input.requested) {
    const path = normalizedPath(request);
    if (path === null) {
      refusals.push(`It needs ${request}, which is not a path inside the repository.`);
      continue;
    }
    if (input.protectedPaths.some((entry) => overlaps(entry, path))) {
      refusals.push(`It needs ${path}, which is a protected path.`);
      continue;
    }
    if (input.requestCheckPaths.some((entry) => covers(entry, path))) {
      refusals.push(`It needs ${path}, a request check that only the base subtask writes.`);
      continue;
    }
    if (input.existingTestPaths.has(path) && !input.authorizedTestChanges.some((entry) => covers(entry, path))) {
      refusals.push(`It needs ${path}, a test that existed before the run and that the spec does not authorize it to change.`);
      continue;
    }
    const owner = input.waveScopes.find((other) => other.scope.some((entry) => overlaps(entry, path)));
    if (owner) {
      refusals.push(`It needs ${path}, which ${owner.subtask} of the same wave owns.`);
      continue;
    }
    const bucket = input.scope.some((entry) => covers(entry, path)) ? covered : free;
    if (!bucket.includes(path)) bucket.push(path);
  }
  if (refusals.length > 0) return { kind: "block", reason: refusals.join(" ") };
  if (free.length === 0) return { kind: "covered", paths: covered };
  return { kind: "extend", paths: free };
}

function normalizedPath(path: string): string | null {
  if (path.startsWith("/")) return null;
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.includes("..")) return null;
  return parts.join("/");
}

function overlaps(entry: string, path: string): boolean {
  return covers(entry, path) || covers(path, entry);
}
