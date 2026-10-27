import type { AttemptOutcome } from "../workers/types.ts";
import type { GateDecision } from "./gate.ts";

export interface AttemptFailure {
  signature: string;
  description: string;
  output?: string;
}

const MAX_LINE = 200;
export const TAIL_LINES = 40;
export const TAIL_BYTES = 4096;
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
  const outputs = decision.rejections.flatMap((rejection) => (rejection.output !== undefined ? [rejection.output] : []));
  return {
    signature: decision.signature,
    description: `The gate rejected the work: ${decision.reasons.join("; ")}`,
    ...(outputs.length > 0 ? { output: outputs.join("\n\n") } : {}),
  };
}

export function outputTail(output: string): string | undefined {
  const lines = output
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  const start = lines.findIndex((line) => line !== "");
  if (start === -1) return undefined;
  const end = lines.findLastIndex((line) => line !== "");
  return lastBytes(lines.slice(Math.max(start, end + 1 - TAIL_LINES), end + 1).join("\n"), TAIL_BYTES);
}

export function outputSection(subject: string, tail: string): string {
  const longest = Math.max(2, ...[...tail.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  return `The last lines of the output of ${subject}:\n\n${fence}text\n${tail}\n${fence}`;
}

function lastBytes(text: string, max: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  const cut = bytes.subarray(bytes.length - max).toString().replace(/^\uFFFD+/, "");
  const newline = cut.indexOf("\n");
  return newline === -1 ? cut : cut.slice(newline + 1);
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
