import { execFileSync } from "node:child_process";
import type { GitHub, Issue, NewPullRequest, PullRequest, PullRequestUpdate, PushDestination } from "../../src/github/github.ts";

export function originOf(repoDir: string): string | undefined {
  try {
    return execFileSync("git", ["-C", repoDir, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

export interface FakePullRequest extends PullRequest {
  head: string;
  base: string;
  title: string;
  body: string;
}

export class FakeGitHub implements GitHub {
  readonly issues = new Map<number, Issue>();
  readonly pullRequests: FakePullRequest[] = [];

  remote: string | undefined;

  constructor(issues: Issue[] = [], remote?: string) {
    for (const issue of issues) this.issues.set(issue.number, issue);
    this.remote = remote;
  }

  async pushDestination(): Promise<PushDestination> {
    if (this.remote === undefined) throw new Error("FakeGitHub has no bare repo to push to");
    return { url: this.remote, gitArgs: [] };
  }

  async readIssue(issue: number): Promise<Issue> {
    const found = this.issues.get(issue);
    if (!found) throw new Error(`issue #${issue} does not exist`);
    return { ...found };
  }

  repositoryUrlFailure: string | null = null;

  async repositoryUrl(): Promise<string> {
    if (this.repositoryUrlFailure !== null) throw new Error(this.repositoryUrlFailure);
    return "https://github.test/aldorea/greeting";
  }

  async findPullRequest(head: string, base: string): Promise<PullRequest | null> {
    const found = this.pullRequests.find((pr) => pr.head === head && pr.base === base);
    return found ? { number: found.number, url: found.url, draft: found.draft } : null;
  }

  async createPullRequest(pullRequest: NewPullRequest): Promise<PullRequest> {
    const number = 100 + this.pullRequests.length;
    const created: FakePullRequest = { ...pullRequest, number, url: `https://github.test/pull/${number}` };
    this.pullRequests.push(created);
    return { number, url: created.url, draft: created.draft };
  }

  async updatePullRequest(number: number, update: PullRequestUpdate): Promise<PullRequest> {
    const found = this.pullRequests.find((pr) => pr.number === number);
    if (!found) throw new Error(`pull request #${number} does not exist`);
    Object.assign(found, update);
    return { number, url: found.url, draft: found.draft };
  }
}
