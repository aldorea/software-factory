import { safeSegments } from "./log-path.ts";
import { parseWebActionId } from "./web-action-files.ts";

const RUN_ID_FORMAT = /^[1-9][0-9]*-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z$/;

export type ApiResource = "runs" | "live" | "actions" | "auth";

export type Route =
  | { kind: "client" }
  | { kind: "api"; resource: ApiResource | null }
  | { kind: "api"; resource: "run" | "run-activity"; runId: string }
  | { kind: "api"; resource: "action" | "action-stop"; actionId: string }
  | { kind: "api"; resource: "run-form"; issue: number }
  | { kind: "api"; resource: "refinement"; issue: number }
  | { kind: "asset"; segments: string[] }
  | { kind: "log"; runId: string; segments: string[] }
  | { kind: "not-found" };

const NOT_FOUND: Route = { kind: "not-found" };
const CLIENT: Route = { kind: "client" };
const API_RESOURCES: readonly ApiResource[] = ["runs", "live", "actions", "auth"];

export function parseRunId(candidate: string): string | null {
  return RUN_ID_FORMAT.test(candidate) ? candidate : null;
}

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function decodedSegments(parts: readonly (string | null)[]): string[] | null {
  return parts.some((part) => part === null) ? null : safeSegments(parts as string[]);
}

function apiRoute(parts: readonly (string | null)[]): Route {
  const [resource, ...rest] = parts;
  if (resource === "runs" && (rest.length === 1 || (rest.length === 2 && rest[1] === "activity"))) {
    const runId = rest[0] === null || rest[0] === undefined ? null : parseRunId(rest[0]);
    if (runId === null) return { kind: "api", resource: null };
    return { kind: "api", resource: rest.length === 1 ? "run" : "run-activity", runId };
  }
  if (resource === "actions" && (rest.length === 1 || (rest.length === 2 && rest[1] === "stop"))) {
    const actionId = rest[0] === null || rest[0] === undefined ? null : parseWebActionId(rest[0]);
    if (actionId === null) return { kind: "api", resource: null };
    return { kind: "api", resource: rest.length === 1 ? "action" : "action-stop", actionId };
  }
  if ((resource === "run-form" || resource === "refinements") && rest.length === 1) {
    const issue = /^[1-9][0-9]{0,8}$/.test(rest[0] ?? "") ? Number(rest[0]) : null;
    if (issue === null) return { kind: "api", resource: null };
    return resource === "run-form" ? { kind: "api", resource: "run-form", issue } : { kind: "api", resource: "refinement", issue };
  }
  const known = API_RESOURCES.find((candidate) => candidate === resource);
  return { kind: "api", resource: known !== undefined && rest.length === 0 ? known : null };
}

function runRoute(segment: string | null | undefined, rest: readonly (string | null)[]): Route {
  if (rest.length === 0) return CLIENT;
  const runId = segment === undefined || segment === null ? null : parseRunId(segment);
  if (runId === null) return NOT_FOUND;
  const segments = decodedSegments(rest);
  return segments === null ? NOT_FOUND : { kind: "log", runId, segments };
}

export function matchRoute(path: string): Route {
  const [root, section, ...rest] = path.split("/").map(decode);
  if (root !== "") return NOT_FOUND;
  if (section === "api") return apiRoute(rest);
  if (section === "assets") {
    const segments = decodedSegments(rest);
    return segments === null ? NOT_FOUND : { kind: "asset", segments };
  }
  if (section === "runs" && rest.length > 0) return runRoute(rest[0], rest.slice(1));
  return CLIENT;
}
