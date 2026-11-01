import type { PushDestination } from "../github/github.ts";
import { exec, execOk } from "../workers/sh.ts";
import type { ExecResult } from "../workers/types.ts";

export const NO_PROMPT_ENV = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };

const LS_REMOTE_TIMEOUT_MS = 30_000;

export type FetchOutcome =
  | { kind: "found"; commit: string }
  | { kind: "absent" }
  | { kind: "failed"; exitCode: number; stderr: string };

export async function pushBranchAttempt(repoDir: string, destination: PushDestination, branch: string): Promise<ExecResult> {
  return exec(
    "git",
    ["-C", repoDir, ...destination.gitArgs, "push", "-q", destination.url, `refs/heads/${branch}:refs/heads/${branch}`],
    { env: NO_PROMPT_ENV },
  );
}

export async function lsRemote(
  repoDir: string,
  destination: PushDestination,
  options: { timeoutMs?: number } = {},
): Promise<ExecResult> {
  try {
    return await exec("git", ["-C", repoDir, ...destination.gitArgs, "ls-remote", destination.url, "HEAD"], {
      env: NO_PROMPT_ENV,
      timeoutMs: options.timeoutMs ?? LS_REMOTE_TIMEOUT_MS,
    });
  } catch (error) {
    const timedOut = (error as { killed?: boolean }).killed === true;
    const timeoutMs = options.timeoutMs ?? LS_REMOTE_TIMEOUT_MS;
    const stderr = timedOut ? `git ls-remote timed out after ${timeoutMs / 1000}s` : (error as Error).message;
    return { exitCode: 1, stdout: "", stderr };
  }
}

export async function fetchBranch(repoDir: string, destination: PushDestination, branch: string): Promise<FetchOutcome> {
  const ref = `refs/heads/${branch}`;
  const listed = await exec("git", ["-C", repoDir, ...destination.gitArgs, "ls-remote", destination.url, ref], {
    env: NO_PROMPT_ENV,
  });
  if (listed.exitCode !== 0) return { kind: "failed", exitCode: listed.exitCode, stderr: listed.stderr };
  const present = listed.stdout.split("\n").some((line) => line.split("\t")[1]?.trim() === ref);
  if (!present) return { kind: "absent" };
  const fetched = await exec("git", ["-C", repoDir, ...destination.gitArgs, "fetch", "--quiet", destination.url, ref], {
    env: NO_PROMPT_ENV,
  });
  if (fetched.exitCode !== 0) return { kind: "failed", exitCode: fetched.exitCode, stderr: fetched.stderr };
  return { kind: "found", commit: (await execOk("git", ["-C", repoDir, "rev-parse", "FETCH_HEAD"])).trim() };
}
