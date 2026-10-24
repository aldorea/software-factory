import type { Verifier, VerifierAnswer, VerifierQuestion } from "../../src/coordinator/verifier.ts";

export type VerifierScript = (question: VerifierQuestion) => VerifierAnswer;

export class FakeVerifier implements Verifier {
  readonly questions: VerifierQuestion[] = [];

  constructor(private readonly script: VerifierScript = () => ({ kind: "accept" })) {}

  async judge(question: VerifierQuestion): Promise<VerifierAnswer> {
    this.questions.push(question);
    return this.script(question);
  }
}
