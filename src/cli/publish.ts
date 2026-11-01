import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { publicationNotification, publishRun } from "../coordinator/publication.ts";
import { latestRunEntry } from "../coordinator/run-history.ts";
import { writeRunLog } from "../coordinator/run-log.ts";
import { defaultBranch } from "../git/repo.ts";
import { envProbes } from "./env-probes.ts";
import type { CliEnv } from "./main.ts";
import { publishDecision } from "./publish-decision.ts";
import { gatherProbes, readiness, readinessProblems } from "./readiness.ts";
import { reportErr } from "./report.ts";
import { runSummary } from "./run-summary.ts";
import { refused } from "./target-repo.ts";

export const PUBLISH_USAGE = "factory publish <issue> [target-repo]";

export const PUBLISH_SUMMARY = "push the branches of the last run of an issue and open or update its pull request, with no agent";

const PUBLISH_HELP = [
  `usage: ${PUBLISH_USAGE}`,
  "",
  "Publishes the last run of an issue again: pushes the branches of the run and opens or updates its pull request.",
  "It launches no agent and spends no plan, so it can run any number of times.",
  "It publishes a run that is ready, draft or paused, and refuses a run that is running or abandoned.",
].join("\n");

interface PublishArgs {
  issue: number;
  repoArg?: string;
}

function parsePublishArgs(args: string[]): PublishArgs | null {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {} });
  } catch {
    return null;
  }
  const [issueArg, repoArg, ...rest] = parsed.positionals;
  const issue = Number(issueArg);
  if (issueArg === undefined || !Number.isInteger(issue) || issue <= 0 || rest.length > 0) return null;
  return { issue, ...(repoArg !== undefined ? { repoArg } : {}) };
}

export async function publish(args: string[], env: CliEnv): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    env.out(PUBLISH_HELP);
    return 0;
  }
  const parsed = parsePublishArgs(args);
  if (parsed === null) {
    env.err(`usage: ${PUBLISH_USAGE}`);
    return 2;
  }
  const repoDir = resolve(env.cwd, parsed.repoArg ?? ".");
  if (await refused(repoDir, env)) return 1;
  try {
    const probes = await gatherProbes("publish", envProbes(repoDir, env));
    const ready = readiness("publish", { probes, roles: {}, credentials: env.credentials });
    if (reportErr(readinessProblems(ready), env)) return 1;
    const logsDir = join(repoDir, ".factory", "logs");
    const latest = await latestRunEntry(logsDir, parsed.issue);
    if (latest === null) {
      env.err(`factory: #${parsed.issue} has no run to publish`);
      return 1;
    }
    const decision = publishDecision(latest, env.clock.now());
    if (decision.kind === "refuse") {
      env.err(`factory: ${decision.reason}`);
      return 1;
    }
    const github = env.github(repoDir);
    const issue = await github.readIssue(parsed.issue);
    const { log } = latest;
    const runDir = join(logsDir, latest.dir);
    const result = await publishRun({
      repoDir,
      issue,
      defaultBranch: await defaultBranch(repoDir),
      log,
      runDir,
      github,
      clock: env.clock,
      save: () => writeRunLog(join(runDir, "run.json"), log),
    });
    await env.notifier.notify(publicationNotification(issue, log, result));
    for (const line of runSummary(log, issue.title, env.color === true)) env.out(line);
    return result.kind === "failed" ? 1 : 0;
  } catch (error) {
    env.err(`factory: ${(error as Error).message}`);
    return 1;
  }
}
