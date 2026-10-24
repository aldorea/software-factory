import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInteractive } from "../../src/cli/launch.ts";
import { integrationBranchName, issueSlug, prepareRefinement, refineLaunch } from "../../src/commands/refine.ts";
import { execOk } from "../../src/workers/sh.ts";
import { FakeGitHub } from "../fakes/github.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

async function git(dir: string, ...args: string[]): Promise<string> {
  return (await execOk("git", ["-C", dir, ...args])).trim();
}

async function targetRepo(): Promise<string> {
  const dir = await temp.make("refine-test-");
  await execOk("git", ["init", "-q", "-b", "main", dir]);
  await git(dir, "config", "user.name", "t");
  await git(dir, "config", "user.email", "t@t");
  await writeFile(join(dir, "README.md"), "# target\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
  return dir;
}

const github = () => new FakeGitHub([{ number: 42, title: "Saved searches", body: "## Acceptance criteria\n" }]);

describe("integration branch name", () => {
  it("should build factory/<n>-<slug> from the title of the issue", () => {
    expect(integrationBranchName(42, "Saved searches")).toBe("factory/42-saved-searches");
  });

  it("should fold accents and punctuation into single hyphens with none at the ends", () => {
    expect(issueSlug("  ¡Búsquedas guardadas: lista & editor!  ")).toBe("busquedas-guardadas-lista-editor");
  });

  it("should cut a long title at a word boundary within 40 characters", () => {
    const slug = issueSlug("Allow every member of the organisation to export all of their saved searches");
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).toBe("allow-every-member-of-the-organisation");
  });

  it("should fall back to issue when the title has no letters or digits", () => {
    expect(integrationBranchName(7, "???")).toBe("factory/7-issue");
  });
});

describe("refinement launch", () => {
  it("should start claude in the worktree with the refinement plugin of this repo and the issue as the skill argument", () => {
    const launch = refineLaunch({ worktree: "/target/.factory/worktrees/42-x", issue: 42, factoryRoot: "/factory" });

    expect(launch).toEqual({
      command: "claude",
      args: ["--plugin-dir", "/factory/plugins/refinement", "/factory:refine 42"],
      cwd: "/target/.factory/worktrees/42-x",
      env: { FACTORY_CLI: "/factory/src/cli/factory.ts" },
    });
  });

  it("should ship the plugin that the launch names, with a skill called refine that ends on factory validate", async () => {
    const root = join(import.meta.dirname, "..", "..");
    const launch = refineLaunch({ worktree: "/w", issue: 1, factoryRoot: root });
    const pluginDir = launch.args[1] as string;

    const manifest = JSON.parse(await readFile(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"));
    const skill = await readFile(join(pluginDir, "skills", "refine", "SKILL.md"), "utf8");

    expect(manifest.name).toBe("factory");
    expect(skill).toMatch(/^---\nname: refine\n/);
    expect(skill).toContain('node "$FACTORY_CLI" validate');
    expect(skill).toContain("A1");
  });
});

describe("interactive launch", () => {
  it("should run the command in the given directory with the given environment and return its exit code", async () => {
    const dir = await temp.make("launch-test-");

    const code = await runInteractive({
      command: process.execPath,
      args: ["-e", "process.exit(process.env.FACTORY_CLI === process.cwd() ? 3 : 4)"],
      cwd: dir,
      env: { FACTORY_CLI: dir },
    });

    expect(code).toBe(3);
  });

  it("should fail with a clear message when the command is not installed", async () => {
    await expect(
      runInteractive({ command: "factory-test-no-such-claude", args: [], cwd: await temp.make("launch-test-"), env: {} }),
    ).rejects.toThrow("factory-test-no-such-claude is not installed");
  });
});

describe("refinement preparation", () => {
  it("should create the integration branch from main and its worktree when both are missing", async () => {
    const repoDir = await targetRepo();
    await git(repoDir, "checkout", "-q", "-b", "elsewhere");
    await git(repoDir, "commit", "-q", "--allow-empty", "-m", "not on main");

    const prepared = await prepareRefinement({ repoDir, issue: 42, github: github() });

    expect(prepared).toEqual({
      branch: "factory/42-saved-searches",
      worktree: join(repoDir, ".factory", "worktrees", "42-saved-searches"),
      created: true,
    });
    expect(await git(prepared.worktree, "rev-parse", "HEAD")).toBe(await git(repoDir, "rev-parse", "main"));
    expect(await git(prepared.worktree, "branch", "--show-current")).toBe("factory/42-saved-searches");
  });

  it("should reuse the branch and the worktree, keeping the work in them, when they already exist", async () => {
    const repoDir = await targetRepo();
    const first = await prepareRefinement({ repoDir, issue: 42, github: github() });
    await writeFile(join(first.worktree, "notes.md"), "draft\n");
    await git(first.worktree, "add", ".");
    await git(first.worktree, "commit", "-q", "-m", "draft");
    const tip = await git(first.worktree, "rev-parse", "HEAD");

    const second = await prepareRefinement({ repoDir, issue: 42, github: github() });

    expect(second).toEqual({ ...first, created: false });
    expect(await git(second.worktree, "rev-parse", "HEAD")).toBe(tip);
  });

  it("should reuse the existing branch even when the title of the issue has changed since", async () => {
    const repoDir = await targetRepo();
    const first = await prepareRefinement({ repoDir, issue: 42, github: github() });
    const renamed = new FakeGitHub([{ number: 42, title: "Saved searches v2", body: "" }]);

    const second = await prepareRefinement({ repoDir, issue: 42, github: renamed });

    expect(second.branch).toBe(first.branch);
    expect(second.worktree).toBe(first.worktree);
  });

  it("should add a worktree for an existing integration branch that has none", async () => {
    const repoDir = await targetRepo();
    await git(repoDir, "branch", "factory/42-saved-searches", "main");

    const prepared = await prepareRefinement({ repoDir, issue: 42, github: github() });

    expect(prepared.created).toBe(false);
    expect(await git(prepared.worktree, "branch", "--show-current")).toBe("factory/42-saved-searches");
  });

  it("should refuse when more than one integration branch exists for the issue", async () => {
    const repoDir = await targetRepo();
    await git(repoDir, "branch", "factory/42-one", "main");
    await git(repoDir, "branch", "factory/42-two", "main");

    await expect(prepareRefinement({ repoDir, issue: 42, github: github() })).rejects.toThrow(
      "more than one integration branch for issue #42: factory/42-one, factory/42-two",
    );
  });

  it("should fail with the message of the tracker when the issue does not exist", async () => {
    const repoDir = await targetRepo();

    await expect(prepareRefinement({ repoDir, issue: 9, github: github() })).rejects.toThrow("issue #9 does not exist");
  });
});
