import { exec } from "./sh.ts";
import type { ExecResult } from "./types.ts";

export async function claudeSessionProblem(command = "claude"): Promise<string | null> {
  let result: ExecResult;
  try {
    result = await exec(command, ["auth", "status"], { timeoutMs: 30_000 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return `Claude Code is not available: install it (${command}) to refine an issue`;
    }
    throw error;
  }
  if (result.exitCode === 0 && loggedIn(result.stdout)) return null;
  return "the Claude Code session of this host is not signed in";
}

function loggedIn(stdout: string): boolean {
  try {
    return (JSON.parse(stdout) as { loggedIn?: unknown }).loggedIn === true;
  } catch {
    return false;
  }
}
