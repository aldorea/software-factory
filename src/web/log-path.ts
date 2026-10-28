import { isAbsolute, relative, resolve, sep } from "node:path";

export type LogUrl = (logPath: string | undefined) => string | null;

const UNSAFE_CHARACTER = /[\0/\\]/;

export function safeSegments(segments: readonly string[]): string[] | null {
  if (segments.length === 0) return null;
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || UNSAFE_CHARACTER.test(segment)) return null;
  }
  return [...segments];
}

export function isInside(realDir: string, realFile: string): boolean {
  const path = relative(realDir, realFile);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function runLogSegments(runDir: string, logPath: string | undefined): string[] | null {
  if (logPath === undefined || logPath === "" || logPath.includes("\0")) return null;
  return safeSegments(relative(runDir, resolve(runDir, logPath)).split(sep));
}

export function runLogUrl(runId: string, segments: readonly string[]): string {
  return `/runs/${encodeURIComponent(runId)}/${segments.map(encodeURIComponent).join("/")}`;
}
