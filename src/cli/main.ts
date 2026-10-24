import { resolve } from "node:path";
import { approveSpec, validateSpecOnBranch, type SpecCommandInput } from "../commands/approve.ts";
import { prepareRefinement, refineLaunch } from "../commands/refine.ts";
import type { GitHub } from "../github/github.ts";
import type { InteractiveLaunch } from "./launch.ts";

export interface CliEnv {
  cwd: string;
  factoryRoot: string;
  now(): Date;
  github(repoDir: string): GitHub;
  protectedPaths(repoDir: string): Promise<string[]>;
  launch(launch: InteractiveLaunch): Promise<number>;
  out(text: string): void;
  err(text: string): void;
}

const USAGE = "usage: factory <refine|approve|validate> <issue> [target-repo]";

export async function main(args: string[], env: CliEnv): Promise<number> {
  const [command, issueArg, repoArg] = args;
  const issue = Number(issueArg);
  if (
    (command !== "refine" && command !== "approve" && command !== "validate") ||
    !Number.isInteger(issue) ||
    issue <= 0 ||
    args.length > 3
  ) {
    env.err(USAGE);
    return 2;
  }
  const repoDir = resolve(env.cwd, repoArg ?? ".");
  if (command === "refine") return refine(repoDir, issue, env);
  try {
    const input: SpecCommandInput = {
      repoDir,
      issue,
      github: env.github(repoDir),
      protectedPaths: await env.protectedPaths(repoDir),
    };
    const outcome =
      command === "approve" ? await approveSpec({ ...input, now: env.now() }) : await validateSpecOnBranch(input);
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
