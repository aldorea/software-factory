import { readPromptTemplate, renderTemplate } from "../prompts/template.ts";
import { revParse } from "../workers/git.ts";
import type { AgentSpec, AttemptResult, Worker } from "../workers/types.ts";
import { outcomeFailure, gateFailure, type AttemptFailure } from "./failures.ts";
import type { GateDecision } from "./gate.ts";
import type { Clock } from "./ports.ts";
import type { AttemptRecord, SubtaskRecord } from "./run-log.ts";
import { countedTokens, stopReason, type StopLimits, type StopReason } from "./stop-rules.ts";

export interface LoopLimits extends StopLimits {
  attemptIdleTimeoutMs: number;
}

export interface SubtaskLoop {
  clock: Clock;
  worker: Worker;
  agent: AgentSpec;
  prompt: string;
  record: SubtaskRecord;
  limits: LoopLimits;
  runStartedAt: Date;
  runTokens: () => number;
  gate: (sha: string, attempt: number) => Promise<GateDecision>;
  save: () => Promise<void>;
}

export type LoopResult =
  | { kind: "accepted" }
  | { kind: "blocked"; stop: StopReason; lastFailure?: string }
  | { kind: "paused"; message: string };

export async function runSubtaskLoop(loop: SubtaskLoop): Promise<LoopResult> {
  const { clock, worker, record, limits } = loop;
  const startedAt = clock.now();
  const signatures: string[] = [];
  let last: AttemptFailure | undefined;
  for (let number = 1; ; number += 1) {
    const now = clock.now();
    const stop = stopReason(
      {
        signatures,
        subtaskElapsedMs: now.getTime() - startedAt.getTime(),
        subtaskTokens: subtaskTokens(record),
        runElapsedMs: now.getTime() - loop.runStartedAt.getTime(),
        runTokens: loop.runTokens(),
      },
      limits,
    );
    if (stop) return { kind: "blocked", stop, ...(last ? { lastFailure: last.description } : {}) };

    const deadline = new Date(
      Math.min(startedAt.getTime() + limits.subtaskWallClockMs, loop.runStartedAt.getTime() + limits.runWallClockMs),
    );
    const prompt = last ? await retryPrompt(loop.prompt, last) : loop.prompt;
    const result = await worker.attempt(loop.agent, prompt, { deadline, idleTimeoutMs: limits.attemptIdleTimeoutMs });
    const attempt = attemptRecord(number, result);
    record.attempts.push(attempt);

    if (result.outcome.kind === "plan-limit") {
      await loop.save();
      return { kind: "paused", message: result.outcome.message };
    }

    let failure = outcomeFailure(result.outcome);
    if (result.outcome.kind === "completed") {
      const sha = await revParse(worker.spec.repoDir, record.branch);
      const decision = await loop.gate(sha, number);
      if (decision.accepted) {
        await loop.save();
        return { kind: "accepted" };
      }
      failure = gateFailure(decision);
    }
    if (failure) {
      attempt.failure = failure;
      signatures.push(failure.signature);
      last = failure;
    }
    await loop.save();
  }
}

async function retryPrompt(base: string, failure: AttemptFailure): Promise<string> {
  const section = renderTemplate(await readPromptTemplate("retry"), { failure: failure.description });
  return `${base}\n\n${section}`;
}

function subtaskTokens(record: SubtaskRecord): number {
  return record.attempts.reduce((total, attempt) => total + countedTokens(attempt.usage), 0);
}

export function attemptRecord(number: number, result: AttemptResult): AttemptRecord {
  const detail = outcomeDetail(result);
  return {
    number,
    outcome: result.outcome.kind,
    ...(detail !== undefined ? { detail } : {}),
    usage: result.usage,
    logPath: result.logPath,
    startedAt: result.startedAt.toISOString(),
    endedAt: result.endedAt.toISOString(),
  };
}

function outcomeDetail(result: AttemptResult): string | undefined {
  const outcome = result.outcome;
  if (outcome.kind === "agent-error" || outcome.kind === "plan-limit") return outcome.message;
  if (outcome.kind === "completed") return outcome.summary;
  return undefined;
}
