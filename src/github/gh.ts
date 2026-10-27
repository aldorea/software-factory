import type { ExecResult } from "../workers/types.ts";
import { exec } from "../workers/sh.ts";
import type { GitHub, Issue, NewPullRequest, PullRequest, PullRequestUpdate } from "./github.ts";

export interface GhOptions {
  repoDir: string;
  command?: string;
}

interface GhPullRequest {
  number: number;
  url: string;
  isDraft: boolean;
}

const PR_FIELDS = "number,url,isDraft";

function toPullRequest(data: GhPullRequest): PullRequest {
  return { number: data.number, url: data.url, draft: data.isDraft };
}

export async function ghProblem(command = "gh"): Promise<string | null> {
  let result: ExecResult;
  try {
    result = await exec(command, ["auth", "status"], { timeoutMs: 30_000 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return `gh is not available: install the GitHub CLI (${command}) and run gh auth login before factory run`;
    }
    throw error;
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    return `gh is not signed in, run gh auth login: ${command} auth status failed with exit code ${result.exitCode}${detail === "" ? "" : `: ${detail}`}`;
  }
  return null;
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
      throw new Error(`gh ${args[0]} ${args[1] ?? ""} failed (${result.exitCode}): ${result.stderr.trim()}`);
    }
    return result.stdout;
  }
  async function view(ref: string): Promise<PullRequest> {
    return toPullRequest(JSON.parse(await gh(["pr", "view", ref, "--json", PR_FIELDS])) as GhPullRequest);
  }
  async function setDraft(number: number, draft: boolean): Promise<void> {
    await gh(["pr", "ready", String(number), ...(draft ? ["--undo"] : [])]);
  }
  return {
    async readIssue(issue: number): Promise<Issue> {
      const data = JSON.parse(await gh(["issue", "view", String(issue), "--json", "number,title,body"])) as Issue;
      return { number: data.number, title: data.title, body: data.body };
    },
    async repositoryUrl(): Promise<string> {
      return (JSON.parse(await gh(["repo", "view", "--json", "url"])) as { url: string }).url;
    },
    async findPullRequest(head: string, base: string): Promise<PullRequest | null> {
      const found = JSON.parse(
        await gh(["pr", "list", "--head", head, "--base", base, "--state", "open", "--json", PR_FIELDS, "--limit", "1"]),
      ) as GhPullRequest[];
      return found[0] ? toPullRequest(found[0]) : null;
    },
    async createPullRequest(pullRequest: NewPullRequest): Promise<PullRequest> {
      const url = await gh([
        "pr",
        "create",
        "--head",
        pullRequest.head,
        "--base",
        pullRequest.base,
        "--title",
        pullRequest.title,
        "--body",
        pullRequest.body,
        ...(pullRequest.draft ? ["--draft"] : []),
      ]);
      return view(url.trim());
    },
    async updatePullRequest(number: number, update: PullRequestUpdate): Promise<PullRequest> {
      await gh(["pr", "edit", String(number), "--title", update.title, "--body", update.body]);
      if ((await view(String(number))).draft !== update.draft) await setDraft(number, update.draft);
      return view(String(number));
    },
  };
}
