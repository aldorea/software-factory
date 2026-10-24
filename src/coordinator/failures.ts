import type { AttemptOutcome } from "../workers/types.ts";
import type { GateDecision } from "./gate.ts";

export interface AttemptFailure {
  signature: string;
  description: string;
}

const MAX_LINE = 200;
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const ERROR_WORDS = /\b(error|fail|failed|failure|fatal|assert\w*|exception)\b/i;

export function outcomeFailure(outcome: AttemptOutcome): AttemptFailure | null {
  switch (outcome.kind) {
    case "completed":
    case "plan-limit":
      return null;
    case "deadline":
      return { signature: "deadline", description: "The attempt reached its deadline before you finished." };
    case "idle-timeout":
      return { signature: "idle-timeout", description: "The attempt was stopped because the agent was idle for too long." };
    case "agent-error": {
      const line = firstLine(outcome.message);
      return {
        signature: line ? `agent-error: ${line}` : "agent-error",
        description: `The agent failed${outcome.exitCode === null ? "" : ` with exit code ${outcome.exitCode}`}${outcome.message ? `: ${outcome.message}` : ""}`,
      };
    }
  }
}

export function gateFailure(decision: GateDecision): AttemptFailure {
  return {
    signature: decision.signature,
    description: `The gate rejected the work: ${decision.reasons.join("; ")}`,
  };
}

export function firstErrorLine(output: string): string | undefined {
  const lines = output
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const line = lines.find((candidate) => ERROR_WORDS.test(candidate)) ?? lines[0];
  return line === undefined ? undefined : line.slice(0, MAX_LINE);
}

function firstLine(text: string): string {
  return firstErrorLine(text.split(/\r?\n/).find((line) => line.trim() !== "") ?? "") ?? "";
}
