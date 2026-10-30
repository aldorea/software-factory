import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { CliEnv } from "./main.ts";

const FIX = "pass the path of the target repo, or run the command from its root";

export function targetRepoRefusal(input: { repoDir: string; factoryRoot: string }): string | null {
  const repoDir = resolve(input.repoDir);
  if (repoDir === resolve(input.factoryRoot)) {
    return `${repoDir} is the factory itself, not a target repo; ${FIX}`;
  }
  const segments = repoDir.split(sep);
  const insideWorktrees = segments.some(
    (segment, index) => segment === ".factory" && segments[index + 1] === "worktrees" && index + 2 < segments.length,
  );
  if (insideWorktrees) {
    return `${repoDir} is inside .factory/worktrees/, so its run log would land in a worktree; ${FIX}`;
  }
  return null;
}

async function resolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

export async function guardTargetRepo(input: { repoDir: string; factoryRoot: string }): Promise<string | null> {
  const [repoDir, factoryRoot] = await Promise.all([resolved(input.repoDir), resolved(input.factoryRoot)]);
  return targetRepoRefusal({ repoDir, factoryRoot });
}

export async function refused(repoDir: string, env: Pick<CliEnv, "factoryRoot" | "err">): Promise<boolean> {
  const refusal = await guardTargetRepo({ repoDir, factoryRoot: env.factoryRoot });
  if (refusal === null) return false;
  env.err(`factory: ${refusal}`);
  return true;
}
