import { spawn } from "node:child_process";
import type { ImageDocker } from "./images.ts";
import { exec } from "./sh.ts";

export function dockerImages(options: {
  user: { uid: number; gid: number };
  output?: "inherit" | "ignore";
}): ImageDocker {
  return {
    user: options.user,
    build: (args) =>
      new Promise((resolve, reject) => {
        const child = spawn("docker", args, { stdio: options.output ?? "inherit" });
        child.once("error", (error: NodeJS.ErrnoException) => {
          reject(error.code === "ENOENT" ? new Error("docker is not installed or not on the PATH") : error);
        });
        child.once("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
      }),
    id: async (reference) => {
      const result = await exec("docker", ["image", "inspect", "--format", "{{.Id}}", reference]);
      const id = result.stdout.trim();
      return result.exitCode === 0 && id !== "" ? id : null;
    },
  };
}
