export const ACTIVITY_TEXT_LIMIT = 100;

export function firstLine(text: string, limit: number = ACTIVITY_TEXT_LIMIT): string | undefined {
  const line = text
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== "");
  if (line === undefined) return undefined;
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

const TARGET_FIELDS = ["file_path", "notebook_path", "command", "pattern", "url", "query", "skill", "description", "path"];

export function toolTarget(input: unknown, cwd: string | undefined): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const fields = input as Record<string, unknown>;
  for (const field of TARGET_FIELDS) {
    const value = fields[field];
    if (typeof value !== "string") continue;
    const target = firstLine(cwd !== undefined && value.startsWith(`${cwd}/`) ? value.slice(cwd.length + 1) : value);
    if (target !== undefined) return target;
  }
  return undefined;
}
