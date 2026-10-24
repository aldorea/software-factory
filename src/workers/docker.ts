import { exec } from "./sh.ts";
import type { ExecResult } from "./types.ts";

export async function dockerProblem(command = "docker"): Promise<string | null> {
  let result: ExecResult;
  try {
    result = await exec(command, ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 30_000 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return `Docker is not available: install Docker (${command}) and start it before factory run`;
    }
    throw error;
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    return `Docker is not running: ${command} info failed with exit code ${result.exitCode}${detail === "" ? "" : `: ${detail}`}`;
  }
  return null;
}
