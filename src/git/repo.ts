import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktreeForBranch, listWorktrees, removeWorktree } from "../workers/git.ts";
import { exec, execOk } from "../workers/sh.ts";

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

export async function integrationBranch(repoDir: string, issue: number): Promise<string> {
  const branch = await findIntegrationBranch(repoDir, issue);
  if (branch === null) {
    throw new Error(`no integration branch factory/${issue}-<slug> in ${repoDir}; run factory refine ${issue} first`);
  }
  return branch;
}

export async function showFile(repoDir: string, ref: string, path: string): Promise<string | null> {
  const shown = await exec("git", ["-C", repoDir, "show", `${ref}:${path}`]);
  return shown.exitCode === 0 ? shown.stdout : null;
}

export async function withBranchWorktree<T>(
  repoDir: string,
  branch: string,
  work: (worktree: string) => Promise<T>,
): Promise<T> {
  const checkedOut = (await listWorktrees(repoDir)).find((entry) => entry.branch === branch);
  if (checkedOut) return work(checkedOut.path);
  const parent = await mkdtemp(join(tmpdir(), "factory-branch-"));
  const worktree = join(parent, "wt");
  try {
    await addWorktreeForBranch(repoDir, worktree, branch);
    return await work(worktree);
  } finally {
    await removeWorktree(repoDir, worktree).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}

export type MergeOutcome = { kind: "merged" } | { kind: "conflict"; files: string[] };

export async function mergeBranch(worktree: string, branch: string, message: string): Promise<MergeOutcome> {
  const merged = await exec("git", ["-C", worktree, "merge", "--no-ff", "--no-edit", "-m", message, branch]);
  if (merged.exitCode === 0) return { kind: "merged" };
  const conflicted = await execOk("git", ["-C", worktree, "diff", "--name-only", "--diff-filter=U"]);
  await exec("git", ["-C", worktree, "merge", "--abort"]);
  const files = conflicted.split("\n").filter((line) => line !== "");
  if (files.length === 0) throw new Error(`git merge ${branch} failed: ${merged.stderr.trim()}`);
  return { kind: "conflict", files };
}

export async function createBranchAt(repoDir: string, branch: string, sha: string): Promise<void> {
  await execOk("git", ["-C", repoDir, "branch", branch, sha]);
}

export async function deleteBranch(repoDir: string, branch: string): Promise<void> {
  await execOk("git", ["-C", repoDir, "branch", "-D", branch]);
}

export async function pushBranch(repoDir: string, remote: string, branch: string): Promise<void> {
  await execOk("git", ["-C", repoDir, "push", "-q", remote, `refs/heads/${branch}:refs/heads/${branch}`]);
}
