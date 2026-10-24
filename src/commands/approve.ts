import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHub } from "../github/github.ts";
import { criteriaHash, technicalHash, writeApproval, type Approval } from "../spec/approval.ts";
import { issueCriteria } from "../spec/issue.ts";
import { parseSpec, validateSpec } from "../spec/spec.ts";
import { addWorktreeForBranch, listWorktrees, removeWorktree, revParse } from "../workers/git.ts";
import { exec, execOk } from "../workers/sh.ts";

export interface SpecCommandInput {
  repoDir: string;
  issue: number;
  github: GitHub;
  protectedPaths: string[];
}

export type ValidateOutcome = { kind: "valid"; branch: string } | { kind: "invalid"; problems: string[] };

export type ApproveOutcome =
  | { kind: "approved"; branch: string; commit: string; approval: Approval }
  | { kind: "invalid"; problems: string[] };

type LoadedSpec =
  | { kind: "valid"; branch: string; specPath: string; specText: string; criteriaHash: string }
  | { kind: "invalid"; problems: string[] };

export async function validateSpecOnBranch(input: SpecCommandInput): Promise<ValidateOutcome> {
  const loaded = await loadSpec(input);
  return loaded.kind === "valid" ? { kind: "valid", branch: loaded.branch } : loaded;
}

export async function approveSpec(input: SpecCommandInput & { now: Date }): Promise<ApproveOutcome> {
  const loaded = await loadSpec(input);
  if (loaded.kind === "invalid") return loaded;
  const approval: Approval = {
    approvedAt: input.now,
    criteriaHash: loaded.criteriaHash,
    technicalHash: technicalHash(loaded.specText),
  };
  await commitOnBranch(
    input.repoDir,
    loaded.branch,
    loaded.specPath,
    writeApproval(loaded.specText, approval),
    `Approve spec #${input.issue}`,
  );
  return { kind: "approved", branch: loaded.branch, commit: await revParse(input.repoDir, loaded.branch), approval };
}

async function loadSpec(input: SpecCommandInput): Promise<LoadedSpec> {
  const branch = await integrationBranch(input.repoDir, input.issue);
  const specPath = `specs/${input.issue}.md`;
  const shown = await exec("git", ["-C", input.repoDir, "show", `${branch}:${specPath}`]);
  if (shown.exitCode !== 0) throw new Error(`${specPath} does not exist on ${branch}`);
  const issue = await input.github.readIssue(input.issue);
  const criteria = issueCriteria(issue.body);
  const hash = criteriaHash(issue.body);
  if (criteria === null || hash === null) {
    return { kind: "invalid", problems: [`issue #${input.issue} has no Acceptance criteria section`] };
  }
  const parsed = parseSpec(shown.stdout);
  if (!parsed.ok) return { kind: "invalid", problems: parsed.problems };
  const problems = validateSpec(parsed.spec, { issueCriteria: criteria, protectedPaths: input.protectedPaths });
  if (problems.length > 0) return { kind: "invalid", problems };
  return { kind: "valid", branch, specPath, specText: shown.stdout, criteriaHash: hash };
}

async function integrationBranch(repoDir: string, issue: number): Promise<string> {
  const out = await execOk("git", [
    "-C",
    repoDir,
    "for-each-ref",
    "--format=%(refname:short)",
    `refs/heads/factory/${issue}-*`,
  ]);
  const branches = out.split("\n").filter((line) => line !== "");
  if (branches.length === 0) {
    throw new Error(`no integration branch factory/${issue}-<slug> in ${repoDir}; run factory refine ${issue} first`);
  }
  if (branches.length > 1) {
    throw new Error(`more than one integration branch for issue #${issue}: ${branches.join(", ")}`);
  }
  return branches[0] as string;
}

async function commitOnBranch(
  repoDir: string,
  branch: string,
  path: string,
  content: string,
  message: string,
): Promise<void> {
  const checkedOut = (await listWorktrees(repoDir)).find((entry) => entry.branch === branch);
  if (checkedOut) {
    const status = await execOk("git", ["-C", checkedOut.path, "status", "--porcelain", "--", path]);
    if (status.trim() !== "") throw new Error(`${path} has uncommitted changes in ${checkedOut.path}`);
    await commitIn(checkedOut.path, path, content, message);
    return;
  }
  const parent = await mkdtemp(join(tmpdir(), "factory-approve-"));
  const worktree = join(parent, "wt");
  try {
    await addWorktreeForBranch(repoDir, worktree, branch);
    await commitIn(worktree, path, content, message);
  } finally {
    await removeWorktree(repoDir, worktree).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}

async function commitIn(worktree: string, path: string, content: string, message: string): Promise<void> {
  await writeFile(join(worktree, path), content);
  await execOk("git", ["-C", worktree, "commit", "-q", "-m", message, "--", path]);
}
