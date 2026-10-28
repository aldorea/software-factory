import { safeSegments } from "./log-path.ts";

const RUN_ID_FORMAT = /^[1-9][0-9]*-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z$/;

export type Route =
  | { kind: "home" }
  | { kind: "run"; runId: string }
  | { kind: "log"; runId: string; segments: string[] }
  | { kind: "not-found" };

const NOT_FOUND: Route = { kind: "not-found" };

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

export function matchRoute(path: string): Route {
  if (path === "/") return { kind: "home" };
  const [root, section, segment, ...rest] = path.split("/").map(decode);
  if (root !== "" || section !== "runs") return NOT_FOUND;
  const runId = segment === undefined || segment === null ? null : parseRunId(segment);
  if (runId === null) return NOT_FOUND;
  if (rest.length === 0) return { kind: "run", runId };
  const segments = rest.some((part) => part === null) ? null : safeSegments(rest as string[]);
  return segments === null ? NOT_FOUND : { kind: "log", runId, segments };
}
