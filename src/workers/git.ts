import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runOk } from "./sh.ts";

export async function revParse(repoDir: string, ref: string): Promise<string> {
  return (await runOk("git", ["-C", repoDir, "rev-parse", ref])).trim();
}

export async function addWorktree(repoDir: string, path: string, branch: string, baseSha: string): Promise<void> {
  await runOk("git", ["-C", repoDir, "worktree", "add", "-b", branch, path, baseSha]);
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
