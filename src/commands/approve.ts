import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { integrationBranch, showFile, withBranchWorktree } from "../git/repo.ts";
import type { GitHub } from "../github/github.ts";
import { criteriaHash, technicalHash, writeApproval, type Approval } from "../spec/approval.ts";
import { issueCriteria } from "../spec/issue.ts";
import { parseSpec, validateSpec } from "../spec/spec.ts";
import { revParse } from "../workers/git.ts";
import { execOk } from "../workers/sh.ts";

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
  const specText = await showFile(input.repoDir, branch, specPath);
  if (specText === null) throw new Error(`${specPath} does not exist on ${branch}`);
  const issue = await input.github.readIssue(input.issue);
  const criteria = issueCriteria(issue.body);
  const hash = criteriaHash(issue.body);
  if (criteria === null || hash === null) {
    return { kind: "invalid", problems: [`issue #${input.issue} has no Acceptance criteria section`] };
  }
  const parsed = parseSpec(specText);
  if (!parsed.ok) return { kind: "invalid", problems: parsed.problems };
  const problems = validateSpec(parsed.spec, { issueCriteria: criteria, protectedPaths: input.protectedPaths });
  if (problems.length > 0) return { kind: "invalid", problems };
  return { kind: "valid", branch, specPath, specText, criteriaHash: hash };
}

async function commitOnBranch(
  repoDir: string,
  branch: string,
  path: string,
  content: string,
  message: string,
): Promise<void> {
  await withBranchWorktree(repoDir, branch, async (worktree) => {
    const status = await execOk("git", ["-C", worktree, "status", "--porcelain", "--", path]);
    if (status.trim() !== "") throw new Error(`${path} has uncommitted changes in ${worktree}`);
    await writeFile(join(worktree, path), content);
    await execOk("git", ["-C", worktree, "commit", "-q", "-m", message, "--", path]);
  });
}
