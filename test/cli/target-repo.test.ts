import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { guardTargetRepo, targetRepoRefusal } from "../../src/cli/target-repo.ts";
import { execOk } from "../../src/workers/sh.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

const FACTORY = "/work/software-factory";

describe("targetRepoRefusal", () => {
  it("should refuse the factory itself", () => {
    const refusal = targetRepoRefusal({ repoDir: FACTORY, factoryRoot: FACTORY });
    expect(refusal).toContain(FACTORY);
    expect(refusal).toContain("the factory itself");
  });

  it("should name the fix: pass the path of the target repo or run from its root", () => {
    const refusal = targetRepoRefusal({ repoDir: FACTORY, factoryRoot: FACTORY });
    expect(refusal).toContain("pass the path of the target repo");
    expect(refusal).toContain("run the command from its root");
  });

  it("should refuse a folder inside .factory/worktrees/ of a repo, because its run log would land there", () => {
    const refusal = targetRepoRefusal({ repoDir: "/work/app/.factory/worktrees/issue-12", factoryRoot: FACTORY });
    expect(refusal).toContain(".factory/worktrees/");
    expect(refusal).toContain("pass the path of the target repo");
  });

  it("should refuse a nested folder inside .factory/worktrees/", () => {
    expect(targetRepoRefusal({ repoDir: "/work/app/.factory/worktrees/issue-12/src", factoryRoot: FACTORY })).not.toBeNull();
  });

  it("should accept a regular target repo", () => {
    expect(targetRepoRefusal({ repoDir: "/work/app", factoryRoot: FACTORY })).toBeNull();
  });

  it("should accept a git worktree that is not under .factory/worktrees/", () => {
    expect(targetRepoRefusal({ repoDir: "/work/app-worktrees/feature", factoryRoot: FACTORY })).toBeNull();
  });

  it("should accept a folder that only looks similar to .factory/worktrees/", () => {
    expect(targetRepoRefusal({ repoDir: "/work/app/.factory-worktrees/x", factoryRoot: FACTORY })).toBeNull();
    expect(targetRepoRefusal({ repoDir: "/work/worktrees/.factory/x", factoryRoot: FACTORY })).toBeNull();
  });

  it("should accept a repo next to the factory whose name starts with the factory name", () => {
    expect(targetRepoRefusal({ repoDir: "/work/software-factory-demo", factoryRoot: FACTORY })).toBeNull();
  });

  it("should ignore a trailing slash", () => {
    expect(targetRepoRefusal({ repoDir: `${FACTORY}/`, factoryRoot: FACTORY })).not.toBeNull();
  });
});

describe("guardTargetRepo", () => {
  it("should refuse a symlink that points to the factory", async () => {
    const parent = await temp.make("guard-");
    const factoryRoot = join(parent, "factory");
    await mkdir(factoryRoot);
    const link = join(parent, "link");
    await symlink(factoryRoot, link);
    expect(await guardTargetRepo({ repoDir: link, factoryRoot })).not.toBeNull();
  });

  it("should refuse a real git worktree placed in .factory/worktrees/", async () => {
    const parent = await temp.make("guard-");
    const repo = join(parent, "app");
    await execOk("git", ["init", "-q", "-b", "main", repo]);
    await execOk("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
    const inside = join(repo, ".factory", "worktrees", "issue-1");
    await mkdir(join(repo, ".factory", "worktrees"), { recursive: true });
    await execOk("git", ["-C", repo, "worktree", "add", "-q", "-b", "x", inside]);
    expect(await guardTargetRepo({ repoDir: inside, factoryRoot: join(parent, "factory") })).not.toBeNull();
  });

  it("should accept a git worktree outside .factory/worktrees/", async () => {
    const parent = await temp.make("guard-");
    const repo = join(parent, "app");
    await execOk("git", ["init", "-q", "-b", "main", repo]);
    await execOk("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
    const outside = join(parent, "app-feature");
    await execOk("git", ["-C", repo, "worktree", "add", "-q", "-b", "y", outside]);
    expect(await guardTargetRepo({ repoDir: outside, factoryRoot: join(parent, "factory") })).toBeNull();
  });
});
