import { safeSegments } from "./log-path.ts";

const RUN_ID_FORMAT = /^[1-9][0-9]*-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z$/;

export type ApiResource = "runs";

export type Route =
  | { kind: "client" }
  | { kind: "api"; resource: ApiResource | null }
  | { kind: "asset"; segments: string[] }
  | { kind: "run"; runId: string }
  | { kind: "log"; runId: string; segments: string[] }
  | { kind: "not-found" };

const NOT_FOUND: Route = { kind: "not-found" };
const CLIENT: Route = { kind: "client" };
const API_RESOURCES: readonly ApiResource[] = ["runs"];

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
  const known = API_RESOURCES.find((candidate) => candidate === resource);
  return { kind: "api", resource: known !== undefined && rest.length === 0 ? known : null };
}

function runRoute(segment: string | null | undefined, rest: readonly (string | null)[]): Route {
  const runId = segment === undefined || segment === null ? null : parseRunId(segment);
  if (runId === null) return rest.length === 0 ? CLIENT : NOT_FOUND;
  if (rest.length === 0) return { kind: "run", runId };
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
