import { readPromptTemplate, renderTemplate } from "../prompts/template.ts";
import type { RoleChoice } from "../config/config.ts";
import type { AttemptLimits, AttemptResult } from "../workers/types.ts";
import { outcomeFailure, gateFailure, type AttemptFailure } from "./failures.ts";
import type { GateDecision } from "./gate.ts";
import type { Clock } from "./ports.ts";
import type { AttemptRecord, SubtaskRecord } from "./run-log.ts";
import type { ScopeExtensionDecision } from "./scope-extension.ts";
import { countedTokens, stopReason, type StopLimits, type StopReason } from "./stop-rules.ts";
import { parseWorkerReport } from "./worker-report.ts";

export interface LoopLimits extends StopLimits {
  attemptIdleTimeoutMs: number;
}

export interface SubtaskLoop {
  clock: Clock;
  agent: RoleChoice;
  prompt: string;
  record: SubtaskRecord;
  limits: LoopLimits;
  runStartedAt: Date;
  runTokens: () => number;
  attempt: (prompt: string, limits: AttemptLimits) => Promise<AttemptResult>;
  gate: (attempt: number) => Promise<GateDecision | null>;
  extendScope: (requested: string[]) => ScopeExtensionDecision;
  save: () => Promise<void>;
}

export type LoopResult =
  | { kind: "accepted" }
  | { kind: "blocked"; stop: StopReason; lastFailure?: string }
  | { kind: "reported"; type: "scope" | "design-question"; reason: string }
  | { kind: "paused"; message: string }
  | { kind: "interrupted" };

export async function runSubtaskLoop(loop: SubtaskLoop): Promise<LoopResult> {
  const { clock, record, limits } = loop;
  const startedAt = clock.now();
  const signatures: string[] = [];
  const first = record.attempts.length;
  const extensions: string[] = [];
  let last: AttemptFailure | undefined;
  for (let number = first + 1; ; number += 1) {
    const now = clock.now();
    const stop = stopReason(
      {
        signatures,
        subtaskElapsedMs: now.getTime() - startedAt.getTime(),
        subtaskTokens: subtaskTokens(record.attempts.slice(first)),
        runElapsedMs: now.getTime() - loop.runStartedAt.getTime(),
        runTokens: loop.runTokens(),
      },
      limits,
    );
    if (stop) return { kind: "blocked", stop, ...(last ? { lastFailure: last.description } : {}) };

    const deadline = new Date(
      Math.min(startedAt.getTime() + limits.subtaskWallClockMs, loop.runStartedAt.getTime() + limits.runWallClockMs),
    );
    const prompt = [last ? await retryPrompt(loop.prompt, last) : loop.prompt, ...extensions].join("\n\n");
    const result = await loop.attempt(prompt, { deadline, idleTimeoutMs: limits.attemptIdleTimeoutMs });
    const attempt = attemptRecord(number, result, loop.agent);
    record.attempts.push(attempt);

    if (result.outcome.kind === "plan-limit") {
      record.state = "pending";
      await loop.save();
      return { kind: "paused", message: result.outcome.message };
    }

    let failure = outcomeFailure(result.outcome);
    const report = result.outcome.kind === "completed" ? parseWorkerReport(result.outcome.summary) : null;
    if (report?.designQuestion !== undefined) {
      return {
        kind: "reported",
        type: "design-question",
        reason: `The worker asked a question of design or product: ${report.designQuestion}`,
      };
    }
    if (report !== null && report.scopeRequests.length > 0) {
      const decision = loop.extendScope(report.scopeRequests);
      if (decision.kind === "block") return { kind: "reported", type: "scope", reason: decision.reason };
      if (decision.kind === "extend") {
        extensions.push(await extensionSection(decision.paths));
        signatures.push(`scope-extension:${decision.paths.join(",")}`);
      } else {
        failure = coveredFailure(decision.paths);
      }
    } else if (result.outcome.kind === "completed") {
      record.state = "gating";
      await loop.save();
      const decision = await loop.gate(number);
      if (decision === null) return { kind: "interrupted" };
      if (decision.accepted) return { kind: "accepted" };
      if (decision.rejections.some((rejection) => rejection.kind !== "verifier")) record.gateRejections += 1;
      if (decision.rejections.some((rejection) => rejection.kind === "verifier")) record.verifierRejections += 1;
      record.state = "working";
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

async function extensionSection(paths: string[]): Promise<string> {
  return renderTemplate(await readPromptTemplate("scope-extension"), { paths: paths.map((path) => `- ${path}`).join("\n") });
}

function coveredFailure(paths: string[]): AttemptFailure {
  return {
    signature: `scope-request:covered:${paths.join(",")}`,
    description: `You asked for ${paths.join(", ")}, but your scope paths already cover ${paths.length === 1 ? "it" : "them"}. Change ${paths.length === 1 ? "it" : "them"} and finish the work.`,
  };
}

async function retryPrompt(base: string, failure: AttemptFailure): Promise<string> {
  const section = renderTemplate(await readPromptTemplate("retry"), { failure: failure.description });
  return `${base}\n\n${section}`;
}

function subtaskTokens(attempts: AttemptRecord[]): number {
  return attempts.reduce((total, attempt) => total + countedTokens(attempt.usage), 0);
}

function attemptRecord(number: number, result: AttemptResult, agent: RoleChoice): AttemptRecord {
  const detail = outcomeDetail(result);
  return {
    number,
    agent,
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
