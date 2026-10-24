export interface Issue {
  number: number;
  title: string;
  body: string;
}

export interface PullRequest {
  number: number;
  url: string;
  draft: boolean;
}

export interface NewPullRequest {
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface PullRequestUpdate {
  title: string;
  body: string;
  draft: boolean;
}

export interface GitHub {
  readIssue(issue: number): Promise<Issue>;
  repositoryUrl(): Promise<string>;
  findPullRequest(head: string, base: string): Promise<PullRequest | null>;
  createPullRequest(pullRequest: NewPullRequest): Promise<PullRequest>;
  updatePullRequest(number: number, update: PullRequestUpdate): Promise<PullRequest>;
}
