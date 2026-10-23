import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addWorktree,
  addWorktreeForBranch,
  branchExists,
  listWorktrees,
  mergeBase,
  removeWorktree,
  revParse,
} from "../../src/workers/git.ts";
import { run, runOk } from "../../src/workers/sh.ts";

async function repo(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "git-test-")));
  await runOk("git", ["init", "-q", "-b", "main", dir]);
  await writeFile(join(dir, "README.md"), "# repo\n");
  await runOk("git", ["-C", dir, "add", "."]);
  await runOk("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
  return dir;
}

describe("git worktrees", () => {
  it("does not write upstream config when it adds a worktree, even if the repo asks for it", async () => {
    const dir = await repo();
    await runOk("git", ["-C", dir, "config", "branch.autoSetupMerge", "always"]);

    await addWorktree(dir, join(dir, "wt"), "feature", "main");

    const upstream = await run("git", ["-C", dir, "config", "--get", "branch.feature.merge"]);
    expect(upstream.exitCode).not.toBe(0);
  });

  it("lists worktrees with their branches", async () => {
    const dir = await repo();
    await addWorktree(dir, join(dir, "wt"), "feature", await revParse(dir, "main"));

    expect(await listWorktrees(dir)).toEqual([
      { path: dir, branch: "main" },
      { path: join(dir, "wt"), branch: "feature" },
    ]);
  });

  it("adds a worktree for an existing branch and finds the base of its commits", async () => {
    const dir = await repo();
    const base = await revParse(dir, "main");
    await addWorktree(dir, join(dir, "wt"), "feature", base);
    await runOk("git", ["-C", join(dir, "wt"), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work"]);
    await removeWorktree(dir, join(dir, "wt"));

    expect(await branchExists(dir, "feature")).toBe(true);
    expect(await branchExists(dir, "missing")).toBe(false);

    await addWorktreeForBranch(dir, join(dir, "wt2"), "feature");
    expect(await mergeBase(dir, "main", "feature")).toBe(base);
  });
});
