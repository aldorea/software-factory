import { idleTimeoutOf, runStatus } from "../coordinator/abandoned.ts";
import type { RunEntry } from "../coordinator/run-history.ts";
import type { BlockType, RunLog, SubtaskRecord, VerificationRecord } from "../coordinator/run-log.ts";
import { formatDuration } from "../coordinator/stop-rules.ts";

export type RunTab = "summary" | "steps" | "verification" | "subtasks" | "activity";

export interface EvidenceLink {
  tab: RunTab;
  anchor: string;
}

export type NextStep =
  | { kind: "command"; purpose: "resume" | "new-run" | "publish"; command: "run" | "publish"; issue: number; flags: string[]; text: string }
  | { kind: "review-spec"; issue: number; text: string };

export type CauseKind =
  | "abandoned"
  | "paused"
  | "publication-failed"
  | "run-block"
  | "blocked-subtask"
  | "environment"
  | "failed-check"
  | "failed-criterion"
  | "tester-error"
  | "failed-verdict"
  | "human-criteria";

export interface RunCause {
  kind: CauseKind;
  where: string;
  what: string;
  detail: string | null;
  evidence: EvidenceLink | null;
  next: NextStep | null;
}

const NEW_RUN_BLOCKS: ReadonlySet<string> = new Set<BlockType>(["environment"]);

function command(purpose: "resume" | "new-run" | "publish", issue: number): NextStep {
  const name = purpose === "publish" ? "publish" : "run";
  return { kind: "command", purpose, command: name, issue, flags: [], text: `factory ${name} ${issue}` };
}

function reviewSpec(issue: number): NextStep {
  return { kind: "review-spec", issue, text: "Revisa la spec y empieza un run nuevo" };
}

function cause(kind: CauseKind, where: string, what: string, detail: string | null, evidence: EvidenceLink | null, next: NextStep | null): RunCause {
  return { kind, where, what, detail, evidence, next };
}

function blockedSubtask(subtask: SubtaskRecord, issue: number): RunCause {
  const type = subtask.blockType ?? subtask.block?.type ?? null;
  const safe = type !== null && NEW_RUN_BLOCKS.has(type);
  return cause(
    "blocked-subtask",
    `Subtask ${subtask.id}`,
    type === null ? "blocked" : `blocked (${type})`,
    subtask.block?.lastFailure ?? subtask.reason ?? subtask.block?.reason ?? null,
    { tab: "subtasks", anchor: `subtask-${subtask.id}` },
    safe ? command("new-run", issue) : reviewSpec(issue),
  );
}

function verificationCauses(verification: VerificationRecord, issue: number): RunCause[] {
  const causes: RunCause[] = [];
  if (verification.environment !== undefined) {
    causes.push(cause("environment", "Integrated verification", "no se pudo ejecutar", verification.environment, { tab: "verification", anchor: "verification" }, command("new-run", issue)));
  }
  for (const check of verification.checks.filter((record) => !record.passed)) {
    causes.push(cause("failed-check", `Integrated verification · check ${check.name}`, "falla", check.firstError ?? null, { tab: "verification", anchor: `verification-check-${check.name}` }, reviewSpec(issue)));
  }
  for (const criterion of verification.criteria.filter((record) => !record.passed)) {
    causes.push(cause("failed-criterion", `Integrated verification · ${criterion.id}`, "falla", criterion.outputTail ?? null, { tab: "verification", anchor: `verification-criterion-${criterion.id}` }, reviewSpec(issue)));
  }
  const tester = verification.tester;
  if (tester?.error !== undefined) {
    causes.push(cause("tester-error", "Acceptance tester", "error", tester.error, { tab: "verification", anchor: "tester" }, command("new-run", issue)));
  }
  for (const verdict of (tester?.verdicts ?? []).filter((record) => !record.passed)) {
    causes.push(cause("failed-verdict", `Acceptance tester · ${verdict.id}`, "falla", verdict.observation, { tab: "verification", anchor: `tester-verdict-${verdict.id}` }, reviewSpec(issue)));
  }
  return causes;
}

function humanCriteria(log: RunLog): RunCause[] {
  const ids = log.verification?.humanCriteria.map((criterion) => criterion.id) ?? log.criteria.human;
  if (log.result !== "draft" || ids.length === 0) return [];
  return [cause("human-criteria", "Criterios human", ids.join(", "), null, { tab: "verification", anchor: "human-criteria" }, null)];
}

export function runCauses(entry: RunEntry, now: Date): RunCause[] {
  const { log } = entry;
  const status = runStatus(entry, now);
  if (status === "running" || status === "ready") return [];
  const issue = log.issue;
  const causes: RunCause[] = [];
  if (status === "abandoned") {
    causes.push(cause("abandoned", "Run", "abandonado", `Ni run.json ni sus raw logs han cambiado en más de ${formatDuration(idleTimeoutOf(log))}`, null, command("new-run", issue)));
  }
  if (log.result === "paused") {
    causes.push(cause("paused", "Run", log.resetsAt === undefined ? "pausado" : `pausado hasta ${log.resetsAt}`, log.pauseReason ?? null, null, command("resume", issue)));
  }
  if (log.publicationFailure !== undefined) {
    const failure = log.publicationFailure;
    causes.push(cause("publication-failed", "Publicación", `falló en ${failure.phase}`, failure.message, { tab: "steps", anchor: "step-publication" }, command("publish", issue)));
  }
  if (log.block !== undefined) {
    causes.push(cause("run-block", "Run", `bloqueado (${log.block.type})`, log.block.reason, { tab: "summary", anchor: "run-block" }, reviewSpec(issue)));
  }
  causes.push(...log.subtasks.filter((subtask) => subtask.state === "blocked").map((subtask) => blockedSubtask(subtask, issue)));
  if (log.verification !== undefined) causes.push(...verificationCauses(log.verification, issue));
  return causes.length === 0 ? humanCriteria(log) : causes;
}
