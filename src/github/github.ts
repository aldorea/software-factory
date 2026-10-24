export interface Issue {
  number: number;
  title: string;
  body: string;
}

export interface GitHub {
  readIssue(issue: number): Promise<Issue>;
}
