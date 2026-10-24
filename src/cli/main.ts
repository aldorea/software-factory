import { resolve } from "node:path";
import { approveSpec, validateSpecOnBranch, type SpecCommandInput } from "../commands/approve.ts";
import { loadConfig } from "../config/load.ts";
import type { Clock, Notifier } from "../coordinator/ports.ts";
import { runIssue } from "../coordinator/run.ts";
import type { GitHub } from "../github/github.ts";
import type { AgentKind, WorkerRunner } from "../workers/types.ts";

export interface CliEnv {
  cwd: string;
  clock: Clock;
  github(repoDir: string): GitHub;
  runner(): WorkerRunner;
  notifier: Notifier;
  credentials: Partial<Record<AgentKind, string>>;
  out(text: string): void;
  err(text: string): void;
}

const COMMANDS = ["approve", "validate", "run"];
const USAGE = `usage: factory <${COMMANDS.join("|")}> <issue> [target-repo]`;

export async function main(args: string[], env: CliEnv): Promise<number> {
  const [command, issueArg, repoArg] = args;
  const issue = Number(issueArg);
  if (!COMMANDS.includes(command ?? "") || !Number.isInteger(issue) || issue <= 0 || args.length > 3) {
    env.err(USAGE);
    return 2;
  }
  const repoDir = resolve(env.cwd, repoArg ?? ".");
  try {
    if (command === "run") {
      const report = await runIssue(
        { repoDir, issue, credentials: env.credentials },
        { runner: env.runner(), github: env.github(repoDir), notifier: env.notifier, clock: env.clock },
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
