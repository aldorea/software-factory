import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { isInside, safeSegments } from "./log-path.ts";

const ABSENT = new Set(["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"]);

function isAbsent(error: unknown): boolean {
  return error instanceof Error && "code" in error && ABSENT.has(String(error.code));
}

export async function resolveFileInside(dir: string, segments: readonly string[]): Promise<string | null> {
  const safe = safeSegments(segments);
  if (safe === null) return null;
  try {
    const realDir = await realpath(dir);
    const realFile = await realpath(join(realDir, ...safe));
    if (!isInside(realDir, realFile)) return null;
    return (await stat(realFile)).isFile() ? realFile : null;
  } catch (error) {
    if (isAbsent(error)) return null;
    throw error;
  }
}

export async function readFileInside(dir: string, segments: readonly string[]): Promise<string | null> {
  const file = await resolveFileInside(dir, segments);
  return file === null ? null : readFile(file, "utf8");
}
