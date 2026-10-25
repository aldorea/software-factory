import type { Verifier, VerifierAnswer, VerifierQuestion, VerifierVerdict } from "../../src/coordinator/verifier.ts";
import { emptyUsage } from "../../src/workers/agent-adapter.ts";

export type ScriptedAnswer = VerifierVerdict & Partial<Pick<VerifierAnswer, "usage" | "usageProblem">>;

export type VerifierScript = (question: VerifierQuestion) => ScriptedAnswer;

export class FakeVerifier implements Verifier {
  readonly questions: VerifierQuestion[] = [];

  private readonly script: VerifierScript;

  constructor(script: VerifierScript = () => ({ kind: "accept" })) {
    this.script = script;
  }

  async judge(question: VerifierQuestion): Promise<VerifierAnswer> {
    this.questions.push(question);
    return { usage: emptyUsage(), ...this.script(question) };
  }
}
