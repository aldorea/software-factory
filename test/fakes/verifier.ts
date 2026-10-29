import type { Verifier, VerifierAnswer, VerifierQuestion, VerifierVerdict } from "../../src/coordinator/verifier.ts";
import { emptyUsage } from "../../src/workers/agent-adapter.ts";
import type { ActivityEvent, ActivitySink } from "../../src/workers/types.ts";

export type ScriptedAnswer = VerifierVerdict & Partial<Pick<VerifierAnswer, "usage" | "usageProblem">> & { activity?: ActivityEvent[] };

export type VerifierScript = (question: VerifierQuestion) => ScriptedAnswer;

export class FakeVerifier implements Verifier {
  readonly questions: VerifierQuestion[] = [];

  private readonly script: VerifierScript;

  constructor(script: VerifierScript = () => ({ kind: "accept" })) {
    this.script = script;
  }

  async judge(question: VerifierQuestion, onActivity?: ActivitySink): Promise<VerifierAnswer> {
    this.questions.push(question);
    const { activity = [], ...answer } = this.script(question);
    for (const event of activity) onActivity?.(event);
    return { usage: emptyUsage(), ...answer };
  }
}
