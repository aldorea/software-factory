import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { approveSpec, validateSpecOnBranch, type SpecCommandInput } from "../commands/approve.ts";
import { prepareRefinement, refineLaunch } from "../commands/refine.ts";
import type { ResolvedConfig, Role, RoleChoice } from "../config/config.ts";
import { loadConfig } from "../config/load.ts";
import { chooseRole, parseRoleFlag, ROLES, type ChosenRole } from "../config/roles.ts";
import type { Clock, Notifier } from "../coordinator/ports.ts";
import { resumeDefaults } from "../coordinator/resume.ts";
import { latestRunLog, readRunLogs } from "../coordinator/run-history.ts";
import { runIssue } from "../coordinator/run.ts";
import { formatStats, summarizeRuns } from "../coordinator/stats.ts";
import type { Verifier } from "../coordinator/verifier.ts";
import type { GitHub } from "../github/github.ts";
import { agentsForRole } from "../workers/agents.ts";
import type { AgentKind, WorkerRunner } from "../workers/types.ts";
import type { InteractiveLaunch } from "./launch.ts";

export interface RoleQuestion {
  role: Role;
  offered: AgentKind[];
  preselected?: RoleChoice;
}

export interface CliEnv {
  cwd: string;
  factoryRoot: string;
  clock: Clock;
  github(repoDir: string): GitHub;
  runner(): WorkerRunner;
  verifier(config: ResolvedConfig, role: RoleChoice): Verifier;
  notifier: Notifier;
  credentials: Partial<Record<AgentKind, string>>;
  ask?: (question: RoleQuestion) => Promise<RoleChoice>;
  launch(launch: InteractiveLaunch): Promise<number>;
  out(text: string): void;
  err(text: string): void;
}

const COMMANDS = ["refine", "approve", "validate", "run"];
const USAGE = [
  `usage: factory <${COMMANDS.join("|")}> <issue> [target-repo]`,
  "       factory run <issue> [target-repo] [--worker-agent <agent>:<model>] [--verifier-agent <agent>:<model>]",
  "       factory stats [target-repo]",
].join("\n");

type RoleFlags = Partial<Record<Role, string>>;

interface Command {
  command: string;
  issue: number;
  repoArg?: string;
  flags: RoleFlags;
}

export async function main(args: string[], env: CliEnv): Promise<number> {
  if (args[0] === "stats") return stats(args.slice(1), env);
  const parsed = parseCommand(args);
  if (parsed === null) {
    env.err(USAGE);
    return 2;
  }
  const { command, issue, repoArg, flags } = parsed;
  const repoDir = resolve(env.cwd, repoArg ?? ".");
  if (command === "refine") return refine(repoDir, issue, env);
  try {
    if (command === "run") return await run(repoDir, issue, flags, env);
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

function parseCommand(args: string[]): Command | null {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { "worker-agent": { type: "string" }, "verifier-agent": { type: "string" } },
    });
  } catch {
    return null;
  }
  const [command, issueArg, repoArg, ...rest] = parsed.positionals;
  const issue = Number(issueArg);
  if (command === undefined || !COMMANDS.includes(command) || !Number.isInteger(issue) || issue <= 0 || rest.length > 0) {
    return null;
  }
  const workers = parsed.values["worker-agent"];
  const verifier = parsed.values["verifier-agent"];
  const flags: RoleFlags = {
    ...(workers !== undefined ? { workers } : {}),
    ...(verifier !== undefined ? { verifier } : {}),
  };
  if (command !== "run" && Object.keys(flags).length > 0) return null;
  return { command, issue, ...(repoArg !== undefined ? { repoArg } : {}), flags };
}

async function run(repoDir: string, issue: number, flags: RoleFlags, env: CliEnv): Promise<number> {
  const config = await loadConfig(repoDir);
  const defaults = resumeDefaults(await latestRunLog(join(repoDir, ".factory", "logs"), issue), config.roles);
  const roles: Partial<Record<Role, RoleChoice>> = {};
  for (const role of ROLES) {
    const chosen = await roleChoice(role, flags[role], defaults[role], env);
    if (!chosen.ok) {
      env.err(`factory: ${chosen.problem}`);
      return 1;
    }
    roles[role] = chosen.choice;
  }
  const report = await runIssue(
    { repoDir, issue, credentials: env.credentials, roles },
    {
      runner: env.runner(),
      verifier: env.verifier(config, roles.verifier as RoleChoice),
      github: env.github(repoDir),
      notifier: env.notifier,
      clock: env.clock,
    },
  );
  env.out(`Run ${report.log.runId}: ${report.result}, ${report.pullRequest.url}`);
  return 0;
}

async function roleChoice(role: Role, flag: string | undefined, fallback: RoleChoice | undefined, env: CliEnv): Promise<ChosenRole> {
  if (flag !== undefined) return parseRoleFlag(role, flag, fallback);
  if (env.ask === undefined) return chooseRole({ role, ...(fallback ? { fallback } : {}) });
  const prompted = await env.ask({ role, offered: agentsForRole(role), ...(fallback ? { preselected: fallback } : {}) });
  return chooseRole({ role, prompted });
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
