import { spawn } from "node:child_process";

export interface InteractiveLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export function launchInteractive(launch: InteractiveLaunch): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: { ...process.env, ...launch.env },
      stdio: "inherit",
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "ENOENT" ? new Error(`${launch.command} is not installed or not on the PATH`) : error);
    });
    child.once("close", (code, signal) => {
      resolve(code ?? (signal ? 128 : 1));
    });
  });
}
