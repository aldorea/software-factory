import type { GitHub, Issue } from "../../src/github/github.ts";

export class FakeGitHub implements GitHub {
  readonly issues = new Map<number, Issue>();

  constructor(issues: Issue[] = []) {
    for (const issue of issues) this.issues.set(issue.number, issue);
  }

  async readIssue(issue: number): Promise<Issue> {
    const found = this.issues.get(issue);
    if (!found) throw new Error(`issue #${issue} does not exist`);
    return { ...found };
  }
}
