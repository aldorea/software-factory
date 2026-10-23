import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { run, runOk } from "./sh.ts";

const NO_CONFIG_WRITE = ["-c", "branch.autoSetupMerge=false", "-c", "push.autoSetupRemote=false"];

export async function revParse(repoDir: string, ref: string): Promise<string> {
  return (await runOk("git", ["-C", repoDir, "rev-parse", ref])).trim();
}

export async function addWorktree(repoDir: string, path: string, branch: string, baseSha: string): Promise<void> {
  await runOk("git", [...NO_CONFIG_WRITE, "-C", repoDir, "worktree", "add", "-b", branch, path, baseSha]);
}

export async function addWorktreeForBranch(repoDir: string, path: string, branch: string): Promise<void> {
  await runOk("git", [...NO_CONFIG_WRITE, "-C", repoDir, "worktree", "add", path, branch]);
}

export async function branchExists(repoDir: string, branch: string): Promise<boolean> {
  const result = await run("git", ["-C", repoDir, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  return result.exitCode === 0;
}

export async function mergeBase(repoDir: string, a: string, b: string): Promise<string> {
  return (await runOk("git", ["-C", repoDir, "merge-base", a, b])).trim();
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
}

export async function listWorktrees(repoDir: string): Promise<WorktreeEntry[]> {
  const out = await runOk("git", ["-C", repoDir, "worktree", "list", "--porcelain"]);
  const entries: WorktreeEntry[] = [];
  for (const block of out.split("\n\n")) {
    const lines = block.split("\n");
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (!path) continue;
    const ref = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
    entries.push({ path, branch: ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null });
  }
  return entries;
}

export async function isClean(worktreePath: string): Promise<boolean> {
  return (await runOk("git", ["-C", worktreePath, "status", "--porcelain"])).trim() === "";
}

export async function removeWorktree(repoDir: string, path: string): Promise<void> {
  await runOk("git", ["-C", repoDir, "worktree", "remove", path]);
}

export async function commitsSince(repoDir: string, baseSha: string, branch: string): Promise<string[]> {
  const out = await runOk("git", ["-C", repoDir, "rev-list", "--reverse", `${baseSha}..${branch}`]);
  return out.split("\n").filter((line) => line !== "");
}

export async function commonGitDir(worktreePath: string): Promise<string> {
  const pointer = (await readFile(join(worktreePath, ".git"), "utf8")).trim();
  const match = /^gitdir:\s*(.+)$/.exec(pointer);
  if (!match?.[1]) {
    throw new Error(`${worktreePath}/.git is not a worktree pointer`);
  }
  return resolve(match[1], "..", "..");
}
