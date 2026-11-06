import { join } from "node:path";
import { emptyUsage } from "../workers/agent-adapter.ts";
import type { ActivityEvent, ActivitySink, TokenUsage } from "../workers/types.ts";
import { criterionTest } from "./criterion-test.ts";
import type { CriterionRecord, VerifierQuestionRecord, VerifierRecord } from "./run-log.ts";
import { addUsage } from "./run-totals.ts";
import type { Verifier, VerifierAnswer, VerifierQuestion, VerifierVerdict } from "./verifier.ts";

export interface TestJudgment {
  records: VerifierRecord[];
  missingTests: string[];
  usage?: TokenUsage;
  usageProblems: string[];
  planLimit?: { message: string; resetsAt?: Date };
}

export interface JudgmentInput {
  repoDir: string;
  integrationBranch: string;
  sha: string;
  criteria: CriterionRecord[];
  texts: Record<string, string>;
  logDir: string;
  label: string;
  onActivity?: (criterion: string, event: ActivityEvent) => void;
  now: () => Date;
  onQuestion?: (question: VerifierQuestionRecord | null) => Promise<void>;
}

export const NO_JUDGMENT: TestJudgment = { records: [], missingTests: [], usageProblems: [] };

export async function judgeTests(verifier: Verifier, input: JudgmentInput): Promise<TestJudgment> {
  const judgment: TestJudgment = { records: [], missingTests: [], usageProblems: [] };
  for (const criterion of input.criteria) {
    if (criterion.evidence !== "playwright") continue;
    const test = await criterionTest(input.repoDir, input.integrationBranch, input.sha, criterion.id);
    if (test === null) {
      judgment.missingTests.push(criterion.id);
      continue;
    }
    const logPath = join(input.logDir, `${input.label}-verifier-${criterion.id}.jsonl`);
    const question = { id: criterion.id, criterion: input.texts[criterion.id] ?? criterion.id, test, logPath };
    const startedAt = input.now().toISOString();
    await input.onQuestion?.({ id: criterion.id, logPath, startedAt });
    const answer = await ask(verifier, question, input.onActivity === undefined ? undefined : (event) => input.onActivity?.(criterion.id, event));
    await input.onQuestion?.(null);
    judgment.usage = addUsage(judgment.usage ?? emptyUsage(), answer.usage);
    if (answer.usageProblem !== undefined) judgment.usageProblems.push(answer.usageProblem);
    if (answer.kind === "plan-limit") {
      const resetsAt = answer.resetsAt !== undefined ? { resetsAt: answer.resetsAt } : {};
      return { ...judgment, planLimit: { message: answer.message, ...resetsAt } };
    }
    judgment.records.push({ ...recordOf(criterion.id, logPath, answer), startedAt, endedAt: input.now().toISOString() });
  }
  return judgment;
}

async function ask(verifier: Verifier, question: VerifierQuestion, onActivity?: ActivitySink): Promise<VerifierAnswer> {
  return verifier.judge(question, onActivity).catch((error: unknown) => ({
    kind: "error" as const,
    message: error instanceof Error ? error.message : String(error),
    usage: emptyUsage(),
  }));
}

function recordOf(id: string, logPath: string, answer: Exclude<VerifierVerdict, { kind: "plan-limit" }>): VerifierRecord {
  if (answer.kind === "accept") return { id, verdict: "accept", logPath };
  if (answer.kind === "refute") return { id, verdict: "refute", reason: answer.reason, logPath };
  return { id, verdict: "error", reason: answer.message, logPath };
}
