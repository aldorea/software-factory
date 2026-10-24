import type { GitHub, Issue, NewPullRequest, PullRequest, PullRequestUpdate } from "../../src/github/github.ts";

export interface FakePullRequest extends PullRequest {
  head: string;
  base: string;
  title: string;
  body: string;
}

export class FakeGitHub implements GitHub {
  readonly issues = new Map<number, Issue>();
  readonly pullRequests: FakePullRequest[] = [];

  constructor(issues: Issue[] = []) {
    for (const issue of issues) this.issues.set(issue.number, issue);
  }

  async readIssue(issue: number): Promise<Issue> {
    const found = this.issues.get(issue);
    if (!found) throw new Error(`issue #${issue} does not exist`);
    return { ...found };
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
