import type { ResolvedConfig } from "../config/config.ts";
import type { AttemptRecord, RunLog, SubtaskRecord, TesterPhase, VerificationRecord } from "./run-log.ts";

export type ProgressConfig = Pick<ResolvedConfig, "checks" | "app">;

export function progressLines(before: RunLog | null, after: RunLog, config: ProgressConfig): string[] {
  if (before === null) return [startLine(after)];
  const previous = new Map(before.subtasks.map((record) => [record.id, record]));
  const lines = after.subtasks.flatMap((record) => subtaskLines(previous.get(record.id), record));
  const verification = settledVerification(after);
  if (verification !== undefined && verification.sha !== settledVerification(before)?.sha) {
    lines.push(`integrated verification at ${verification.sha.slice(0, 12)}: ${verification.passed ? "passed" : "failed"}`);
  }
  const phase = after.verification?.testerPhase;
  if (phase !== undefined && phase !== before.verification?.testerPhase) {
    const line = testerPhaseLine(phase, config);
    if (line !== null) lines.push(`tester: ${line}`);
  }
  if (after.pauseReason !== undefined && before.pauseReason === undefined) lines.push(`run paused: ${after.pauseReason}`);
  if (after.result !== before.result) lines.push(`run ${after.runId}: ${after.result}`);
  if (after.pullRequest !== undefined && after.pullRequest.url !== before.pullRequest?.url) {
    lines.push(`pull request: ${after.pullRequest.url}`);
  }
  return lines;
}

function settledVerification(log: RunLog): VerificationRecord | undefined {
  return log.verification?.testerPhase === undefined ? log.verification : undefined;
}

function testerPhaseLine(phase: TesterPhase, config: ProgressConfig): string | null {
  const [install] = config.checks;
  const { app } = config;
  if (phase === "install" && install !== undefined) return `running the ${install.name} check`;
  if (phase === "start" && app !== undefined) return `starting the app with ${app.start}`;
  if (phase === "ready" && app?.ready !== undefined) return `waiting for the app to be ready (${app.ready})`;
  return null;
}

function startLine(log: RunLog): string {
  const { agent, model } = log.agents.workers;
  const count = log.subtasks.length;
  return `run ${log.runId}: ${count} ${count === 1 ? "subtask" : "subtasks"}, workers on ${agent} ${model}`;
}

function subtaskLines(before: SubtaskRecord | undefined, after: SubtaskRecord): string[] {
  const attempts = after.attempts
    .filter((attempt, index) => attempt.outcome !== "running" && (before?.attempts[index] === undefined || before.attempts[index]?.outcome === "running"))
    .map((attempt) => attemptLine(after.id, attempt));
  if (after.state === before?.state) return attempts;
  return [...attempts, `${after.id}: ${after.state}${after.state === "blocked" && after.blockType ? ` (${after.blockType})` : ""}`];
}

function attemptLine(subtask: string, attempt: AttemptRecord): string {
  const failure = attempt.failure === undefined ? "" : `: ${attempt.failure.signature}`;
  return `${subtask}: attempt ${attempt.number} ${attempt.outcome}${failure}`;
}
