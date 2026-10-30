import { readFile } from "node:fs/promises";
import { join } from "node:path";

const FLOOR = /^>=(\d+)\.(\d+)\.(\d+)$/;

function numbers(version: string): number[] {
  return version.split(".").map(Number);
}

export function nodeProblem(running: string, range: string): string | null {
  const floor = FLOOR.exec(range);
  if (floor === null) return `cannot read the floor of Node from engines in package.json: ${range}`;
  const wanted = floor.slice(1).map(Number);
  const have = numbers(running);
  for (const [index, part] of wanted.entries()) {
    const current = have[index] ?? 0;
    if (current !== part) {
      return current > part
        ? null
        : `Node ${running} is older than ${wanted.join(".")}, the floor of engines in package.json`;
    }
  }
  return null;
}

export async function nodeProblemOf(factoryRoot: string, running: string): Promise<string | null> {
  const file = join(factoryRoot, "package.json");
  let range: unknown;
  try {
    range = (JSON.parse(await readFile(file, "utf8")) as { engines?: { node?: unknown } }).engines?.node;
  } catch {
    range = undefined;
  }
  if (typeof range !== "string") return `cannot read engines.node from ${file}`;
  return nodeProblem(running, range);
}
