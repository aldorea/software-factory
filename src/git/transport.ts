import type { PushDestination } from "../github/github.ts";
import { exec } from "../workers/sh.ts";
import type { ExecResult } from "../workers/types.ts";

export const NO_PROMPT_ENV = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };

export async function pushBranchAttempt(repoDir: string, destination: PushDestination, branch: string): Promise<ExecResult> {
  return exec(
    "git",
    ["-C", repoDir, ...destination.gitArgs, "push", "-q", destination.url, `refs/heads/${branch}:refs/heads/${branch}`],
    { env: NO_PROMPT_ENV },
  );
}

export async function pushBranch(repoDir: string, destination: PushDestination, branch: string): Promise<void> {
  const pushed = await pushBranchAttempt(repoDir, destination, branch);
  if (pushed.exitCode !== 0) throw new Error(`git push ${branch} failed (${pushed.exitCode}): ${pushed.stderr.trim()}`);
}

export async function fetchBranch(repoDir: string, destination: PushDestination, branch: string): Promise<boolean> {
  const fetched = await exec(
    "git",
    ["-C", repoDir, ...destination.gitArgs, "fetch", "--quiet", destination.url, `refs/heads/${branch}`],
    { env: NO_PROMPT_ENV },
  );
  return fetched.exitCode === 0;
}
