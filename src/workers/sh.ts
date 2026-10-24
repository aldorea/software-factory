import { execFile } from "node:child_process";
import type { ExecResult } from "./types.ts";

export function exec(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd: options.cwd, timeout: options.timeoutMs ?? 0, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ exitCode: error ? Number(error.code) : 0, stdout, stderr });
      },
    );
  });
}

export async function execOk(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<string> {
  const result = await exec(command, args, options);
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}
