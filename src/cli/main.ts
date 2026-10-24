import { join, resolve } from "node:path";
import { approveSpec, validateSpecOnBranch, type SpecCommandInput } from "../commands/approve.ts";
import { prepareRefinement, refineLaunch } from "../commands/refine.ts";
import { loadConfig } from "../config/load.ts";
import type { Clock, Notifier } from "../coordinator/ports.ts";
import { runIssue } from "../coordinator/run.ts";
import { readRunLogs } from "../coordinator/run-history.ts";
import { formatStats, summarizeRuns } from "../coordinator/stats.ts";
import type { Verifier } from "../coordinator/verifier.ts";
import type { GitHub } from "../github/github.ts";
import type { AgentKind, WorkerRunner } from "../workers/types.ts";
import type { InteractiveLaunch } from "./launch.ts";

export interface CliEnv {
  cwd: string;
  factoryRoot: string;
  clock: Clock;
  github(repoDir: string): GitHub;
  runner(): WorkerRunner;
  verifier(repoDir: string): Verifier;
  notifier: Notifier;
  credentials: Partial<Record<AgentKind, string>>;
  launch(launch: InteractiveLaunch): Promise<number>;
  out(text: string): void;
  err(text: string): void;
}

const COMMANDS = ["refine", "approve", "validate", "run"];
const USAGE = `usage: factory <${COMMANDS.join("|")}> <issue> [target-repo]\n       factory stats [target-repo]`;

export async function main(args: string[], env: CliEnv): Promise<number> {
  if (args[0] === "stats") return stats(args.slice(1), env);
  const [command, issueArg, repoArg] = args;
  const issue = Number(issueArg);
  if (!COMMANDS.includes(command ?? "") || !Number.isInteger(issue) || issue <= 0 || args.length > 3) {
    env.err(USAGE);
    return 2;
  }
  const repoDir = resolve(env.cwd, repoArg ?? ".");
  if (command === "refine") return refine(repoDir, issue, env);
  try {
    if (command === "run") {
      const report = await runIssue(
        { repoDir, issue, credentials: env.credentials },
        { runner: env.runner(), verifier: env.verifier(repoDir), github: env.github(repoDir), notifier: env.notifier, clock: env.clock },
      );
      env.out(`Run ${report.log.runId}: ${report.result}, ${report.pullRequest.url}`);
      return 0;
    }
    const input: SpecCommandInput = {
      repoDir,
      issue,
      github: env.github(repoDir),
      protectedPaths: (await loadConfig(repoDir)).protectedPaths,
    };
    const outcome =
      command === "approve" ? await approveSpec({ ...input, now: env.clock.now() }) : await validateSpecOnBranch(input);
    if (outcome.kind === "invalid") {
      env.err([`specs/${issue}.md is invalid:`, ...outcome.problems.map((problem) => `- ${problem}`)].join("\n"));
      return 1;
    }
    env.out(
      outcome.kind === "approved"
        ? `Approved spec #${issue} on ${outcome.branch} (${outcome.commit.slice(0, 12)})`
        : `specs/${issue}.md on ${outcome.branch} is valid`,
    );
    return 0;
  } catch (error) {
    env.err(`factory: ${(error as Error).message}`);
    return 1;
  }
}

async function refine(repoDir: string, issue: number, env: CliEnv): Promise<number> {
  try {
    const workspace = await prepareRefinement({ repoDir, issue, github: env.github(repoDir) });
    env.out(`${workspace.created ? "Created" : "Reusing"} ${workspace.branch} in ${workspace.worktree}`);
    return await env.launch(refineLaunch({ worktree: workspace.worktree, issue, factoryRoot: env.factoryRoot }));
  } catch (error) {
    env.err(`factory: ${(error as Error).message}`);
    return 1;
  }
}

async function stats(args: string[], env: CliEnv): Promise<number> {
  if (args.length > 1) {
    env.err(USAGE);
    return 2;
  }
  try {
    const { logs, unreadable } = await readRunLogs(join(resolve(env.cwd, args[0] ?? "."), ".factory", "logs"));
    env.out(formatStats(summarizeRuns(logs), unreadable));
    return 0;
  } catch (error) {
    env.err(`factory: ${(error as Error).message}`);
    return 1;
  }
}
