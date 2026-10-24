import { join } from "node:path";
import { criterionTest } from "./criterion-test.ts";
import type { CriterionRecord, VerifierRecord } from "./run-log.ts";
import type { Verifier, VerifierAnswer } from "./verifier.ts";

export interface TestJudgment {
  records: VerifierRecord[];
  missingTests: string[];
}

export interface JudgmentInput {
  repoDir: string;
  integrationBranch: string;
  sha: string;
  criteria: CriterionRecord[];
  texts: Record<string, string>;
  logDir: string;
  label: string;
}

export const NO_JUDGMENT: TestJudgment = { records: [], missingTests: [] };

export async function judgeTests(verifier: Verifier, input: JudgmentInput): Promise<TestJudgment> {
  const judgment: TestJudgment = { records: [], missingTests: [] };
  for (const criterion of input.criteria) {
    if (criterion.evidence !== "playwright") continue;
    const test = await criterionTest(input.repoDir, input.integrationBranch, input.sha, criterion.id);
    if (test === null) {
      judgment.missingTests.push(criterion.id);
      continue;
    }
    const logPath = join(input.logDir, `${input.label}-verifier-${criterion.id}.jsonl`);
    const answer = await ask(verifier, { id: criterion.id, criterion: input.texts[criterion.id] ?? criterion.id, test, logPath });
    judgment.records.push(recordOf(criterion.id, logPath, answer));
  }
  return judgment;
}

async function ask(verifier: Verifier, question: Parameters<Verifier["judge"]>[0]): Promise<VerifierAnswer> {
  return verifier.judge(question).catch((error: unknown) => ({
    kind: "error" as const,
    message: error instanceof Error ? error.message : String(error),
  }));
}

function recordOf(id: string, logPath: string, answer: VerifierAnswer): VerifierRecord {
  if (answer.kind === "accept") return { id, verdict: "accept", logPath };
  if (answer.kind === "refute") return { id, verdict: "refute", reason: answer.reason, logPath };
  return { id, verdict: "error", reason: answer.message, logPath };
}
