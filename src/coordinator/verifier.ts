import type { ActivitySink, TokenUsage } from "../workers/types.ts";

export interface VerifierQuestion {
  id: string;
  criterion: string;
  test: string;
  logPath: string;
}

export type VerifierVerdict =
  | { kind: "accept" }
  | { kind: "refute"; reason: string }
  | { kind: "error"; message: string }
  | { kind: "plan-limit"; message: string; resetsAt?: Date };

export type VerifierAnswer = VerifierVerdict & { usage: TokenUsage; usageProblem?: string };

export interface Verifier {
  judge(question: VerifierQuestion, onActivity?: ActivitySink): Promise<VerifierAnswer>;
}
