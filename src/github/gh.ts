import type { ExecResult } from "../workers/types.ts";
import { exec } from "../workers/sh.ts";
import type { GitHub, Issue } from "./github.ts";

export interface GhOptions {
  repoDir: string;
  command?: string;
}

export function ghGitHub(options: GhOptions): GitHub {
  const command = options.command ?? "gh";
  async function gh(args: string[]): Promise<string> {
    let result: ExecResult;
    try {
      result = await exec(command, args, { cwd: options.repoDir });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`gh is not available: install the GitHub CLI (${command}) and run gh auth login`);
      }
      throw error;
    }
    if (result.exitCode !== 0) {
      throw new Error(`gh ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim()}`);
    }
    return result.stdout;
  }
  return {
    async readIssue(issue: number): Promise<Issue> {
      const data = JSON.parse(await gh(["issue", "view", String(issue), "--json", "number,title,body"])) as Issue;
      return { number: data.number, title: data.title, body: data.body };
    },
  };
}
