export const ACTIVITY_TEXT_LIMIT = 100;

export function firstLine(text: string, limit: number = ACTIVITY_TEXT_LIMIT): string | undefined {
  const line = text
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== "");
  if (line === undefined) return undefined;
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}
