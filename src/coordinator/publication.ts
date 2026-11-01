import type { GitHub, Issue, PullRequest } from "../github/github.ts";
import { pushBranchAttempt } from "../git/transport.ts";
import { evidenceBranchName, evidenceFiles, publishEvidence } from "./evidence-branch.ts";
import type { Clock, Notification } from "./ports.ts";
import { renderPullRequest } from "./pull-request.ts";
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
  save(): Promise<void>;
}

export type StepOutcome<T = void> = { ok: true; value: T } | { ok: false; message: string };

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
  const { log, clock, save } = publication;
  const failed = async (phase: PublicationPhase, message: string): Promise<PublicationResult> => {
    log.publicationFailure = { phase, message, at: clock.now().toISOString() };
    await save();
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

export async function pushIntegrationBranch({ repoDir, github, log }: Publication): Promise<StepOutcome> {
  try {
    const destination = await github.pushDestination();
    const pushed = await pushBranchAttempt(repoDir, destination, log.integrationBranch);
    if (pushed.exitCode !== 0) {
      return { ok: false, message: `git push ${log.integrationBranch} failed (${pushed.exitCode}): ${pushed.stderr.trim()}` };
    }
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

export async function pushEvidenceBranch({ repoDir, github, log, runDir, save }: Publication): Promise<StepOutcome> {
  delete log.evidence;
  const tested = (log.verification?.tester?.verdicts ?? []).map((verdict) => ({ id: verdict.id, attachments: verdict.evidence }));
  const files = evidenceFiles(log.runId, runDir, [...(log.verification?.humanCriteria ?? []), ...tested]);
  if (files.length === 0) return { ok: true, value: undefined };
  const record: EvidenceBranchRecord = { branch: evidenceBranchName(log.issue) };
  log.evidence = record;
  try {
    const destination = await github.pushDestination();
    record.commit = await publishEvidence({ repoDir, destination, issue: log.issue, runId: log.runId, files });
    record.repositoryUrl = await github.repositoryUrl();
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  } finally {
    await save();
  }
}

export async function openPullRequest({ github, issue, defaultBranch, log }: Publication): Promise<StepOutcome<PullRequest>> {
  try {
    const text = renderPullRequest(issue, log);
    const draft = log.result !== "ready";
    const existing = await github.findPullRequest(log.integrationBranch, defaultBranch);
    const pullRequest = existing
      ? await github.updatePullRequest(existing.number, { ...text, draft })
      : await github.createPullRequest({ ...text, head: log.integrationBranch, base: defaultBranch, draft });
    return { ok: true, value: pullRequest };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}
