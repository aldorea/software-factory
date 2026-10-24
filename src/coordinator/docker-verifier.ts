import type { ResolvedConfig, RoleChoice } from "../config/config.ts";
import { readPromptTemplate, renderTemplate } from "../prompts/template.ts";
import { CREDENTIAL_VARIABLES } from "../config/roles.ts";
import type { AgentKind, AttemptOutcome } from "../workers/types.ts";
import { askVerifier } from "../workers/verifier.ts";
import type { Clock } from "./ports.ts";
import type { Verifier, VerifierAnswer, VerifierQuestion } from "./verifier.ts";

export const QUESTION_TIMEOUT_MS = 10 * 60 * 1000;

export interface VerifierSetup {
  image: string;
  role: RoleChoice;
  env: Record<string, string>;
  idleTimeoutMs: number;
  clock: Clock;
}

export function configuredVerifier(
  config: ResolvedConfig,
  role: RoleChoice,
  credentials: Partial<Record<AgentKind, string>>,
  clock: Clock,
): Verifier {
  return {
    async judge(question) {
      const variable = CREDENTIAL_VARIABLES[role.agent];
      const credential = credentials[role.agent];
      if (!credential) throw new Error(`${variable} is not set; the ${role.agent} verifier needs it`);
      return dockerVerifier({
        image: config.image,
        role,
        env: { [variable]: credential },
        idleTimeoutMs: config.limits.attemptIdleTimeoutMs,
        clock,
      }).judge(question);
    },
  };
}

export function dockerVerifier(setup: VerifierSetup): Verifier {
  if (setup.role.agent !== "opencode") {
    throw new Error(`${setup.role.agent} cannot serve the verifier: only opencode denies every tool with a fail-closed check`);
  }
  return {
    async judge(question) {
      const prompt = renderTemplate(await readPromptTemplate("verifier"), {
        criterion: question.criterion,
        test: question.test,
      });
      const result = await askVerifier({
        image: setup.image,
        env: setup.env,
        model: setup.role.model,
        prompt,
        logPath: question.logPath,
        limits: { deadline: new Date(setup.clock.now().getTime() + QUESTION_TIMEOUT_MS), idleTimeoutMs: setup.idleTimeoutMs },
      });
      return answerFrom(result.outcome);
    },
  };
}

export function answerFrom(outcome: AttemptOutcome): VerifierAnswer {
  if (outcome.kind === "agent-error") return { kind: "error", message: outcome.message };
  if (outcome.kind === "plan-limit") {
    return { kind: "plan-limit", message: outcome.message, ...(outcome.resetsAt !== undefined ? { resetsAt: outcome.resetsAt } : {}) };
  }
  if (outcome.kind !== "completed") return { kind: "error", message: `the verifier ended with ${outcome.kind}` };
  const text = outcome.summary.trim();
  if (text === "") return { kind: "error", message: "the verifier gave no answer" };
  const [first = "", ...rest] = text.split("\n");
  const verdict = /^(ACCEPT|REFUTE)\b[\s:.-]*(.*)$/i.exec(first.trim());
  if (verdict === null) return { kind: "error", message: `the verifier did not answer ACCEPT or REFUTE: ${text}` };
  if (verdict[1]?.toUpperCase() === "ACCEPT") return { kind: "accept" };
  const reason = [verdict[2] ?? "", ...rest].join("\n").trim();
  return { kind: "refute", reason: reason === "" ? "the verifier gave no reason" : reason };
}
