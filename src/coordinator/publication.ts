import type { GitHub, Issue, PullRequest, PushDestination } from "../github/github.ts";
import { pushBranchAttempt } from "../git/transport.ts";
import type { ExecResult } from "../workers/types.ts";
import { commitEvidence, evidenceBranchName, evidenceFiles } from "./evidence-branch.ts";
import type { Clock, Notification } from "./ports.ts";
import { renderPullRequest } from "./pull-request.ts";
import { classifyFailure, sleepFor, withRetries, type Attempt } from "./retry.ts";
import type { EvidenceBranchRecord, PublicationPhase, RunLog } from "./run-log.ts";

export type PublicationResult =
  | { kind: "published"; pullRequest: PullRequest }
  | { kind: "failed"; phase: PublicationPhase; message: string };

export interface Publication {
  repoDir: string;
  issue: Issue;
  defaultBranch: string;
  log: RunLog;
  runDir: string;
  github: GitHub;
  clock: Clock;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  progress?: ((line: string) => void) | undefined;
  save(): Promise<void>;
}

export type StepOutcome<T = void> = Attempt<T>;

export const WORKFLOW_SCOPE_FIX = "gh auth refresh -s workflow";

const PHASE_LABELS: Record<PublicationPhase, string> = {
  "integration-push": "the integration push",
  "evidence-push": "the evidence push",
  "pull-request": "the pull request",
};

export function notPublishedMessage(title: string, issue: number): string {
  return `Not published: ${title} → factory publish ${issue}`;
}

export function publicationNotification(issue: Issue, log: RunLog, result: PublicationResult): Notification {
  const title = `factory run #${issue.number}`;
  if (result.kind === "failed") return { title, message: notPublishedMessage(issue.title, issue.number) };
  return { title, message: resultMessage(log, issue.title), url: result.pullRequest.url };
}

function resultMessage(log: RunLog, title: string): string {
  if (log.result === "ready") return `Ready for review: ${title}`;
  if (log.result !== "paused") return `Draft: ${title}`;
  return log.resetsAt === undefined ? `Paused: ${title}` : `Paused until the plan limit resets at ${log.resetsAt}: ${title}`;
}

export async function publishRun(publication: Publication): Promise<PublicationResult> {
  const { log, clock, save, progress } = publication;
  const failed = async (phase: PublicationPhase, message: string): Promise<PublicationResult> => {
    log.publicationFailure = { phase, message, at: clock.now().toISOString() };
    await save();
    progress?.(`publication failed at ${PHASE_LABELS[phase]}: ${message.split("\n").map((line) => line.trim()).join(" | ")}`);
    return { kind: "failed", phase, message };
  };

  const integration = await pushIntegrationBranch(publication);
  if (!integration.ok) return failed("integration-push", integration.message);
  const evidence = await pushEvidenceBranch(publication);
  if (!evidence.ok) return failed("evidence-push", evidence.message);
  const pullRequest = await openPullRequest(publication);
  if (!pullRequest.ok) return failed("pull-request", pullRequest.message);

  delete log.publicationFailure;
  log.pullRequest = { number: pullRequest.value.number, url: pullRequest.value.url, draft: pullRequest.value.draft };
  await save();
  return { kind: "published", pullRequest: pullRequest.value };
}

function retrying<T>(publication: Publication, attempt: () => Promise<Attempt<T>>): Promise<Attempt<T>> {
  return withRetries(attempt, {
    sleep: publication.sleep ?? sleepFor,
    onRetry: ({ retry, retries, waitMs, message }) =>
      publication.progress?.(`publication: retry ${retry} of ${retries} in ${waitMs / 1000}s: ${message.split("\n")[0]}`),
  });
}

function thrown(error: unknown): Attempt<never> {
  const message = (error as Error).message;
  return { ok: false, message, failure: classifyFailure(message, 1) };
}

function pushFailure(branch: string, pushed: ExecResult): Attempt<never> {
  const stderr = pushed.stderr
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  const message = `git push ${branch} failed (${pushed.exitCode}): ${stderr}`;
  const lacksScope = /without `?workflow`? scope/i.test(pushed.stderr);
  return {
    ok: false,
    message: lacksScope ? `${message}\n→ ${WORKFLOW_SCOPE_FIX}` : message,
    failure: classifyFailure(pushed.stderr, pushed.exitCode),
  };
}

async function pushAttempt(repoDir: string, destination: PushDestination, branch: string): Promise<Attempt<void>> {
  const pushed = await pushBranchAttempt(repoDir, destination, branch);
  return pushed.exitCode === 0 ? { ok: true, value: undefined } : pushFailure(branch, pushed);
}

export function pushIntegrationBranch(publication: Publication): Promise<StepOutcome> {
  const { repoDir, github, log } = publication;
  return retrying(publication, async () => {
    try {
      return await pushAttempt(repoDir, await github.pushDestination(), log.integrationBranch);
    } catch (error) {
      return thrown(error);
    }
  });
}

export async function pushEvidenceBranch(publication: Publication): Promise<StepOutcome> {
  const { repoDir, github, log, runDir, save } = publication;
  delete log.evidence;
  const tested = (log.verification?.tester?.verdicts ?? []).map((verdict) => ({ id: verdict.id, attachments: verdict.evidence }));
  const files = evidenceFiles(log.runId, runDir, [...(log.verification?.humanCriteria ?? []), ...tested]);
  if (files.length === 0) return { ok: true, value: undefined };
  const record: EvidenceBranchRecord = { branch: evidenceBranchName(log.issue) };
  log.evidence = record;
  try {
    const destination = await github.pushDestination();
    const commit = await commitEvidence({ repoDir, destination, issue: log.issue, runId: log.runId, files });
    const pushed = await retrying(publication, () => pushAttempt(repoDir, destination, record.branch));
    if (!pushed.ok) return pushed;
    record.commit = commit;
    record.repositoryUrl = await github.repositoryUrl();
    return { ok: true, value: undefined };
  } catch (error) {
    return thrown(error);
  } finally {
    await save();
  }
}

export function openPullRequest(publication: Publication): Promise<StepOutcome<PullRequest>> {
  const { github, issue, defaultBranch, log } = publication;
  return retrying(publication, async () => {
    try {
      const text = renderPullRequest(issue, log);
      const draft = log.result !== "ready";
      const existing = await github.findPullRequest(log.integrationBranch, defaultBranch);
      const pullRequest = existing
        ? await github.updatePullRequest(existing.number, { ...text, draft })
        : await github.createPullRequest({ ...text, head: log.integrationBranch, base: defaultBranch, draft });
      return { ok: true, value: pullRequest };
    } catch (error) {
      return thrown(error);
    }
  });
}
