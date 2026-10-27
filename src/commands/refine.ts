import { join } from "node:path";
import type { InteractiveLaunch } from "../cli/launch.ts";
import type { GitHub } from "../github/github.ts";
import { addWorktree, addWorktreeForBranch, listWorktrees, revParse } from "../workers/git.ts";
import { defaultBranch, findIntegrationBranch } from "../git/repo.ts";

const MAX_SLUG_LENGTH = 40;

export function refineLaunch(input: { worktree: string; issue: number; factoryRoot: string }): InteractiveLaunch {
  return {
    command: "claude",
    args: ["--plugin-dir", join(input.factoryRoot, "plugins", "refinement"), `/factory:refine ${input.issue}`],
    cwd: input.worktree,
    env: { FACTORY_CLI: join(input.factoryRoot, "src", "cli", "factory.ts") },
  };
}

export interface RefinementWorkspace {
  branch: string;
  worktree: string;
  created: boolean;
}

export async function prepareRefinement(input: {
  repoDir: string;
  issue: number;
  github: GitHub;
}): Promise<RefinementWorkspace> {
  const existing = await findIntegrationBranch(input.repoDir, input.issue);
  const base = existing ? null : await defaultBranch(input.repoDir);
  const branch = existing ?? integrationBranchName(input.issue, (await input.github.readIssue(input.issue)).title);
  const checkedOut = (await listWorktrees(input.repoDir)).find((entry) => entry.branch === branch);
  if (checkedOut) return { branch, worktree: checkedOut.path, created: false };
  const worktree = join(input.repoDir, ".factory", "worktrees", branch.slice("factory/".length));
  if (base === null) {
    await addWorktreeForBranch(input.repoDir, worktree, branch);
    return { branch, worktree, created: false };
  }
  await addWorktree(input.repoDir, worktree, branch, await revParse(input.repoDir, base));
  return { branch, worktree, created: true };
}

export function issueSlug(title: string): string {
  const words = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
  const kept: string[] = [];
  for (const word of words) {
    const next = [...kept, word].join("-");
    if (next.length > MAX_SLUG_LENGTH && kept.length > 0) break;
    kept.push(word);
  }
  const slug = kept.join("-").slice(0, MAX_SLUG_LENGTH).replace(/-+$/, "");
  return slug === "" ? "issue" : slug;
}

export function integrationBranchName(issue: number, title: string): string {
  return `factory/${issue}-${issueSlug(title)}`;
}
