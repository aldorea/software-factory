import { execOk } from "../workers/sh.ts";

export async function findIntegrationBranch(repoDir: string, issue: number): Promise<string | null> {
  const out = await execOk("git", [
    "-C",
    repoDir,
    "for-each-ref",
    "--format=%(refname:short)",
    `refs/heads/factory/${issue}-*`,
  ]);
  const branches = out.split("\n").filter((line) => line !== "");
  if (branches.length > 1) {
    throw new Error(`more than one integration branch for issue #${issue}: ${branches.join(", ")}`);
  }
  return branches[0] ?? null;
}
