import { exec } from "../workers/sh.ts";
import type { ExecResult } from "../workers/types.ts";

export async function ghProblem(command = "gh"): Promise<string | null> {
  let result: ExecResult;
  try {
    result = await exec(command, ["auth", "status"], { timeoutMs: 30_000 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return `gh is not available: install the GitHub CLI (${command}) before factory run`;
    }
    throw error;
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    return `gh is not signed in: ${command} auth status failed with exit code ${result.exitCode}${detail === "" ? "" : `: ${detail}`}; run gh auth login`;
  }
  return null;
}
