import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approveSpec, validateSpecOnBranch } from "../../src/commands/approve.ts";
import { criteriaHash, readApproval, technicalHash } from "../../src/spec/approval.ts";
import { addWorktreeForBranch, listWorktrees, revParse } from "../../src/workers/git.ts";
import { execOk } from "../../src/workers/sh.ts";
import { FakeGitHub } from "../fakes/github.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

const BRANCH = "factory/42-saved-searches";
const protectedPaths = ["package.json", "src/db/schema.ts"];
const issueBody = [
  "## What to build",
  "",
  "Saved searches.",
  "",
  "## Acceptance criteria",
  "",
  "- [ ] A1 A search can be saved.",
  "- [ ] A2 Saved searches are listed.",
  "- [ ] A3 The editor looks right.",
  "",
].join("\n");

const fixture = (name: string) => readFile(join(import.meta.dirname, "..", "spec", "fixtures", name), "utf8");

async function git(dir: string, ...args: string[]): Promise<string> {
  return (await execOk("git", ["-C", dir, ...args])).trim();
}

async function targetRepo(spec: string): Promise<string> {
  const dir = await temp.make("approve-test-");
  await execOk("git", ["init", "-q", "-b", "main", dir]);
  await git(dir, "config", "user.name", "t");
  await git(dir, "config", "user.email", "t@t");
  await writeFile(join(dir, "README.md"), "# target\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
  await git(dir, "switch", "-q", "-c", BRANCH);
  await mkdir(join(dir, "specs"));
  await writeFile(join(dir, "specs", "42.md"), spec);
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "Spec #42");
  await git(dir, "switch", "-q", "main");
  return dir;
}

function github(body = issueBody): FakeGitHub {
  return new FakeGitHub([{ number: 42, title: "Saved searches", body }]);
}

describe("approveSpec", () => {
  it("should write the date and both hashes in the spec header and commit the approval on the integration branch", async () => {
    const spec = await fixture("valid.md");
    const repoDir = await targetRepo(spec);
    const mainBefore = await revParse(repoDir, "main");
    const now = new Date("2026-10-24T08:00:00.000Z");

    const outcome = await approveSpec({ repoDir, issue: 42, github: github(), protectedPaths, now });

    expect(outcome.kind).toBe("approved");
    const approved = await git(repoDir, "show", `${BRANCH}:specs/42.md`);
    expect(readApproval(approved)).toEqual({
      kind: "approved",
      approval: { approvedAt: now, criteriaHash: criteriaHash(issueBody), technicalHash: technicalHash(spec) },
    });
    expect(await git(repoDir, "log", "-1", "--format=%s", BRANCH)).toBe("Approve spec #42");
    expect(await revParse(repoDir, "main")).toBe(mainBefore);
    expect(await listWorktrees(repoDir)).toEqual([{ path: repoDir, branch: "main" }]);
  });

  it("should commit in the worktree that has the integration branch checked out, so that worktree stays clean", async () => {
    const repoDir = await targetRepo(await fixture("valid.md"));
    const worktree = join(repoDir, "wt");
    await addWorktreeForBranch(repoDir, worktree, BRANCH);

    await approveSpec({ repoDir, issue: 42, github: github(), protectedPaths, now: new Date() });

    expect(readApproval(await readFile(join(worktree, "specs", "42.md"), "utf8")).kind).toBe("approved");
    expect(await git(worktree, "status", "--porcelain")).toBe("");
    await git(repoDir, "worktree", "remove", worktree);
  });

  it("should refuse an invalid spec, name its problems and write nothing", async () => {
    const spec = (await fixture("valid.md")).replace(', "reason": "The layout of the editor is a visual judgement."', "");
    const repoDir = await targetRepo(spec);
    const before = await revParse(repoDir, BRANCH);

    const outcome = await approveSpec({ repoDir, issue: 42, github: github(), protectedPaths, now: new Date() });

    expect(outcome).toEqual({ kind: "invalid", problems: ["criterion A3 is human but gives no reason"] });
    expect(await revParse(repoDir, BRANCH)).toBe(before);
  });

  it("should refuse a spec that names a criterion missing from the issue", async () => {
    const repoDir = await targetRepo(await fixture("valid.md"));
    const body = issueBody.replace("- [ ] A3 The editor looks right.\n", "");

    const outcome = await approveSpec({ repoDir, issue: 42, github: github(body), protectedPaths, now: new Date() });

    expect(outcome.kind).toBe("invalid");
  });

  it("should replace the old date and hashes when the spec is approved again", async () => {
    const repoDir = await targetRepo(await fixture("valid.md"));
    await approveSpec({ repoDir, issue: 42, github: github(), protectedPaths, now: new Date("2026-10-24T08:00:00Z") });
    const worktree = join(repoDir, "wt");
    await addWorktreeForBranch(repoDir, worktree, BRANCH);
    const changed = (await readFile(join(worktree, "specs", "42.md"), "utf8")).replace("share no file", "share no path");
    await writeFile(join(worktree, "specs", "42.md"), changed);
    await git(worktree, "commit", "-q", "-am", "Edit spec #42");
    const body = issueBody.replace("looks right", "looks tidy");
    const later = new Date("2026-10-25T09:30:00.000Z");

    await approveSpec({ repoDir, issue: 42, github: github(body), protectedPaths, now: later });

    const approved = await git(repoDir, "show", `${BRANCH}:specs/42.md`);
    expect(approved.match(/factory-approval/g)).toHaveLength(1);
    expect(readApproval(approved)).toEqual({
      kind: "approved",
      approval: { approvedAt: later, criteriaHash: criteriaHash(body), technicalHash: technicalHash(changed) },
    });
    await git(repoDir, "worktree", "remove", worktree);
  });

  it("should refuse to overwrite uncommitted changes to the spec in the worktree of the integration branch", async () => {
    const repoDir = await targetRepo(await fixture("valid.md"));
    const worktree = join(repoDir, "wt");
    await addWorktreeForBranch(repoDir, worktree, BRANCH);
    await writeFile(join(worktree, "specs", "42.md"), "work in progress\n");

    await expect(
      approveSpec({ repoDir, issue: 42, github: github(), protectedPaths, now: new Date() }),
    ).rejects.toThrow(`specs/42.md has uncommitted changes in ${worktree}`);
    expect(await readFile(join(worktree, "specs", "42.md"), "utf8")).toBe("work in progress\n");
    await git(repoDir, "worktree", "remove", "--force", worktree);
  });

  it("should fail with a clear message when the integration branch does not exist", async () => {
    const repoDir = await targetRepo(await fixture("valid.md"));
    await git(repoDir, "branch", "-q", "-D", BRANCH);

    await expect(
      approveSpec({ repoDir, issue: 42, github: github(), protectedPaths, now: new Date() }),
    ).rejects.toThrow("no integration branch factory/42-<slug> in");
  });

  it("should fail with a clear message when the spec is not on the integration branch", async () => {
    const repoDir = await targetRepo(await fixture("valid.md"));
    await git(repoDir, "branch", "-q", "factory/7-other", "main");

    await expect(
      approveSpec({ repoDir, issue: 7, github: new FakeGitHub([{ number: 7, title: "x", body: issueBody }]), protectedPaths, now: new Date() }),
    ).rejects.toThrow("specs/7.md does not exist on factory/7-other");
  });
});

describe("validateSpecOnBranch", () => {
  it("should accept a valid spec and write nothing", async () => {
    const repoDir = await targetRepo(await fixture("valid.md"));
    const before = await revParse(repoDir, BRANCH);

    expect(await validateSpecOnBranch({ repoDir, issue: 42, github: github(), protectedPaths })).toEqual({
      kind: "valid",
      branch: BRANCH,
    });
    expect(await revParse(repoDir, BRANCH)).toBe(before);
  });

  it("should report an issue with no criteria section as a problem of the spec", async () => {
    const repoDir = await targetRepo(await fixture("valid.md"));

    expect(
      await validateSpecOnBranch({ repoDir, issue: 42, github: github("## What to build\n"), protectedPaths }),
    ).toEqual({ kind: "invalid", problems: ["issue #42 has no Acceptance criteria section"] });
  });
});
