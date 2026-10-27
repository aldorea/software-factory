import type { Subtask } from "../spec/spec.ts";
import { isAncestor, mergeBranch, withBranchWorktree } from "../git/repo.ts";
import { revParse } from "../workers/git.ts";
import { verifyIntegration } from "./integrated-verification.ts";
import { paused, type RunContext } from "./run-context.ts";

export async function includeDefaultBranch(context: RunContext, subtasks: Subtask[]): Promise<void> {
  const { repoDir } = context.request;
  const { branch, defaultBranch } = context.prepared;
  const { log } = context;
  while (!paused(context) && log.verification?.passed === true && log.subtasks.every((subtask) => subtask.state === "merged")) {
    if (await isAncestor(repoDir, defaultBranch, branch)) return;
    const sha = await revParse(repoDir, branch);
    const merged = await context.gitLock.exclusive(() =>
      withBranchWorktree(repoDir, branch, (worktree) => mergeBranch(worktree, defaultBranch, defaultBranchMergeMessage(defaultBranch))),
    );
    if (merged.kind === "conflict") {
      context.conflicted = true;
      log.block = {
        type: "default-branch-conflict",
        reason: `${defaultBranch} moved during the run, and its merge into ${branch} conflicts in ${merged.files.join(", ")}.`,
        sha,
        files: merged.files,
      };
      await context.save();
      return;
    }
    await verifyIntegration(context, subtasks);
  }
}

export function defaultBranchMergeMessage(defaultBranch: string): string {
  return `Merge ${defaultBranch} into the integration branch`;
}
