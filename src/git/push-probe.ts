import type { GitHub, PushDestination } from "../github/github.ts";
import { exec } from "../workers/sh.ts";
import { REMOTE } from "./repo.ts";
import { lsRemote } from "./transport.ts";

export interface GithubRepo {
  owner: string;
  repo: string;
}

const NAME = "[A-Za-z0-9._-]+";
const REMOTE_FORMS = [
  new RegExp(`^(?:[^@/\\s]+@)?github\\.com:(${NAME})/(${NAME}?)(?:\\.git)?/?$`),
  new RegExp(`^(?:https?|ssh|git)://(?:[^@/\\s]+@)?github\\.com(?::\\d+)?/(${NAME})/(${NAME}?)(?:\\.git)?/?$`),
];

export function githubRepoOfRemote(remote: string): GithubRepo | null {
  for (const form of REMOTE_FORMS) {
    const match = form.exec(remote.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) return { owner: match[1], repo: match[2] };
  }
  return null;
}

async function originUrl(repoDir: string): Promise<string | null> {
  const url = await exec("git", ["-C", repoDir, "remote", "get-url", REMOTE]);
  return url.exitCode === 0 ? url.stdout.trim() : null;
}

export async function pushProblem(
  repoDir: string,
  github: GitHub,
  options: { timeoutMs?: number } = {},
): Promise<string | null> {
  const origin = await originUrl(repoDir);
  if (origin === null) return `the repo has no ${REMOTE} remote`;
  const named = githubRepoOfRemote(origin);
  if (named === null) return `${REMOTE} is not a GitHub repo: ${origin}`;
  const unreachable = `cannot reach github.com/${named.owner}/${named.repo} with the gh session`;
  let destination: PushDestination;
  try {
    destination = await github.pushDestination();
  } catch {
    return unreachable;
  }
  const listed = await lsRemote(repoDir, destination, options);
  return listed.exitCode === 0 ? null : unreachable;
}
