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
  gitArgs: string[] = [];
  nextRemotes: string[] = [];

  constructor(issues: Issue[] = [], remote?: string) {
    for (const issue of issues) this.issues.set(issue.number, issue);
    this.remote = remote;
  }

  async pushDestination(): Promise<PushDestination> {
    const remote = this.nextRemotes.shift() ?? this.remote;
    if (remote === undefined) throw new Error("FakeGitHub has no bare repo to push to");
    return { url: remote, gitArgs: this.gitArgs };
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

  pullRequestFailure: string | null = null;
  pullRequestFailures = Infinity;

  private failPullRequestCall(): void {
    if (this.pullRequestFailure === null || this.pullRequestFailures <= 0) return;
    this.pullRequestFailures--;
    throw new Error(this.pullRequestFailure);
  }

  async findPullRequest(head: string, base: string): Promise<PullRequest | null> {
    this.failPullRequestCall();
    const found = this.pullRequests.find((pr) => pr.head === head && pr.base === base);
    return found ? { number: found.number, url: found.url, draft: found.draft } : null;
  }

  async createPullRequest(pullRequest: NewPullRequest): Promise<PullRequest> {
    this.failPullRequestCall();
    const number = 100 + this.pullRequests.length;
    const created: FakePullRequest = { ...pullRequest, number, url: `https://github.test/pull/${number}` };
    this.pullRequests.push(created);
    return { number, url: created.url, draft: created.draft };
  }

  async updatePullRequest(number: number, update: PullRequestUpdate): Promise<PullRequest> {
    this.failPullRequestCall();
    const found = this.pullRequests.find((pr) => pr.number === number);
    if (!found) throw new Error(`pull request #${number} does not exist`);
    Object.assign(found, update);
    return { number, url: found.url, draft: found.draft };
  }
}
