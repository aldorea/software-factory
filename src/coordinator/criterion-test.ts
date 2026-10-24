import { showFile } from "../git/repo.ts";
import { mergeBase } from "../workers/git.ts";
import { execOk } from "../workers/sh.ts";

export function mentionsCriterion(text: string, id: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${id}($|[^A-Za-z0-9_])`).test(text);
}

export async function criterionTest(
  repoDir: string,
  integrationBranch: string,
  sha: string,
  id: string,
): Promise<string | null> {
  const base = await mergeBase(repoDir, integrationBranch, sha);
  const changed = (await execOk("git", ["-C", repoDir, "diff", "--name-only", "--diff-filter=AM", base, sha]))
    .split("\n")
    .filter((path) => path !== "");
  const sources: string[] = [];
  for (const path of changed) {
    const source = await showFile(repoDir, sha, path);
    if (source !== null && mentionsCriterion(source, id)) sources.push(source);
  }
  return sources.length === 0 ? null : sources.join("\n\n");
}
