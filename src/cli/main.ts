import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { approveSpec, validateSpecOnBranch, type SpecCommandInput } from "../commands/approve.ts";
import { prepareRefinement, refineLaunch } from "../commands/refine.ts";
import type { ResolvedConfig, Role, RoleChoice, RunRole } from "../config/config.ts";
import { configPath, loadConfig } from "../config/load.ts";
import { choiceProblems, chooseRole, parseRoleFlag, ROLES, type ChosenRole } from "../config/roles.ts";
import type { Clock, Notifier } from "../coordinator/ports.ts";
import { abandonedLogs, lastChange, runAbandoned } from "../coordinator/abandoned.ts";
import { defaultOrigin, resumeDefaults } from "../coordinator/resume.ts";
import { latestRunEntry, readRunEntries } from "../coordinator/run-history.ts";
import { runIssue } from "../coordinator/run.ts";
import { formatStats, summarizeRuns } from "../coordinator/stats.ts";
import type { Verifier } from "../coordinator/verifier.ts";
import type { GitHub } from "../github/github.ts";
import { initRepo } from "../init/init.ts";
import { WEB_HOST } from "../web/host.ts";
import { DEFAULT_WEB_PORT } from "../web/server.ts";
import type { AgentKind, WorkerRunner } from "../workers/types.ts";
import { activityLine } from "./activity-line.ts";
import { clockMinutes } from "./clock-time.ts";
import type { InteractiveLaunch } from "./launch.ts";
import { planLimitAnnotate } from "./plan-limit-warning.ts";
import { menuEntries, type Annotate, type RoleEntry } from "./role-menu.ts";
import { runSummary } from "./run-summary.ts";
import { RunView } from "./run-view.ts";
import { refused } from "./target-repo.ts";
import { renderProgress } from "./terminal-render.ts";
import { web, WEB_USAGE } from "./web.ts";

export interface CliEnv {
  cwd: string;
  factoryRoot: string;
  clock: Clock;
  github(repoDir: string): GitHub;
  runner(): WorkerRunner;
  verifier(config: ResolvedConfig, role: RoleChoice): Verifier;
  notifier: Notifier;
  credentials: Partial<Record<AgentKind, string>>;
  docker(): Promise<string | null>;
  gh(): Promise<string | null>;
  ask?: (entries: RoleEntry[], annotate: Annotate) => Promise<Partial<Record<Role, RoleChoice>>>;
  terminal?: { columns(): number; write(text: string): void };
  launch(launch: InteractiveLaunch): Promise<number>;
  signal: AbortSignal;
  out(text: string): void;
  err(text: string): void;
}

const COMMANDS = ["refine", "approve", "validate", "run"];
const USAGE = [
  `usage: factory <${COMMANDS.join("|")}> <issue> [target-repo]`,
  "       factory refine <issue> [target-repo] [--refinement-agent <agent>:<model>]",
  "       factory run <issue> [target-repo] [--worker-agent <agent>:<model>] [--verifier-agent <agent>:<model>] [--tester-agent <agent>:<model>]",
  "       factory stats [target-repo]",
  `       ${WEB_USAGE}`,
  "       factory init [target-repo]",
].join("\n");

type RoleFlags = Partial<Record<RunRole, string>>;

interface Command {
  command: string;
  issue: number;
  repoArg?: string;
  flags: RoleFlags;
  refinementFlag?: string;
}

export async function main(args: string[], env: CliEnv): Promise<number> {
  if (args[0] === "stats") return stats(args.slice(1), env);
  if (args[0] === "init") return init(args.slice(1), env);
  if (args[0] === "web") return web(args.slice(1), env, USAGE);
  const parsed = parseCommand(args);
  if (parsed === null) {
    env.err(USAGE);
    return 2;
  }
  const { command, issue, repoArg, flags, refinementFlag } = parsed;
  const repoDir = resolve(env.cwd, repoArg ?? ".");
  if (await refused(repoDir, env)) return 1;
  if (command === "refine") return refine(repoDir, issue, refinementFlag, env);
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
      options: {
        "worker-agent": { type: "string" },
        "verifier-agent": { type: "string" },
        "tester-agent": { type: "string" },
        "refinement-agent": { type: "string" },
      },
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
  const tester = parsed.values["tester-agent"];
  const flags: RoleFlags = {
    ...(workers !== undefined ? { workers } : {}),
    ...(verifier !== undefined ? { verifier } : {}),
    ...(tester !== undefined ? { tester } : {}),
  };
  const refinementFlag = parsed.values["refinement-agent"];
  if (command !== "run" && Object.keys(flags).length > 0) return null;
  if (command !== "refine" && refinementFlag !== undefined) return null;
  return {
    command,
    issue,
    ...(repoArg !== undefined ? { repoArg } : {}),
    flags,
    ...(refinementFlag !== undefined ? { refinementFlag } : {}),
  };
}

async function run(repoDir: string, issue: number, flags: RoleFlags, env: CliEnv): Promise<number> {
  const toolProblems = [await env.docker(), await env.gh()].filter((problem) => problem !== null);
  if (toolProblems.length > 0) {
    for (const problem of toolProblems) env.err(`factory: ${problem}`);
    return 1;
  }
  const config = await loadConfig(repoDir);
  const latest = await latestRunEntry(join(repoDir, ".factory", "logs"), issue);
  const previous = latest?.log ?? null;
  if (latest !== null && runAbandoned(latest, env.clock.now())) {
    env.out(`run ${latest.log.runId} of #${issue} was abandoned at ${clockMinutes(lastChange(latest))}; starting a new run`);
  }
  const defaults = resumeDefaults(previous, config.roles);
  const flagged: Partial<Record<RunRole, RoleChoice>> = {};
  for (const role of ROLES) {
    const flag = flags[role];
    if (flag === undefined) continue;
    const parsed = parseRoleFlag(role, flag, defaults[role]);
    if (!parsed.ok) {
      env.err(`factory: ${parsed.problem}`);
      return 1;
    }
    flagged[role] = parsed.choice;
  }
  const prompted =
    env.ask === undefined
      ? {}
      : await env.ask(
          menuEntries({ roles: ROLES, flagged, defaults, defaultOrigin: (role) => defaultOrigin(previous, role) }),
          planLimitAnnotate(previous, env.clock.now()),
        );
  const roles: Partial<Record<RunRole, RoleChoice>> = {};
  for (const role of ROLES) {
    const chosen = chooseRole({
      role,
      ...(flagged[role] ? { flag: flagged[role] } : {}),
      ...(prompted[role] ? { prompted: prompted[role] } : {}),
      ...(defaults[role] ? { fallback: defaults[role] } : {}),
    });
    if (!chosen.ok) {
      env.err(`factory: ${chosen.problem}`);
      return 1;
    }
    roles[role] = chosen.choice;
  }
  env.out(`Preparing run #${issue}; factory web shows it at http://${WEB_HOST}:${DEFAULT_WEB_PORT}/`);
  const view = env.terminal ? new RunView({ now: () => env.clock.now(), ...env.terminal }) : null;
  const ticker = view ? setInterval(() => view.tick(), 1000) : null;
  let report;
  try {
    report = await runIssue(
      { repoDir, issue, credentials: env.credentials, roles },
      {
        runner: env.runner(),
        verifier: env.verifier(config, roles.verifier as RoleChoice),
        github: env.github(repoDir),
        notifier: env.notifier,
        clock: env.clock,
        progress: view ? (line) => view.progress(line) : (line) => env.out(renderProgress(line, env.clock.now(), false)),
        activity: view ? (entry) => view.activity(entry) : (entry) => env.out(activityLine(entry)),
        ...(view ? { snapshot: (log) => view.snapshot(log) } : {}),
      },
    );
  } finally {
    if (ticker) clearInterval(ticker);
    view?.finish();
  }
  for (const line of runSummary(report.log)) env.out(line);
  return 0;
}

async function refine(repoDir: string, issue: number, flag: string | undefined, env: CliEnv): Promise<number> {
  try {
    const chosen = await refinementChoice(repoDir, flag, env);
    if (!chosen.ok) {
      env.err(`factory: ${chosen.problem}`);
      return 1;
    }
    const workspace = await prepareRefinement({ repoDir, issue, github: env.github(repoDir) });
    env.out(`${workspace.created ? "Created" : "Reusing"} ${workspace.branch} in ${workspace.worktree}`);
    return await env.launch(
      refineLaunch({ worktree: workspace.worktree, issue, factoryRoot: env.factoryRoot, model: chosen.choice.model }),
    );
  } catch (error) {
    env.err(`factory: ${(error as Error).message}`);
    return 1;
  }
}

async function refinementChoice(repoDir: string, flag: string | undefined, env: CliEnv): Promise<ChosenRole> {
  const configured = await configuredRefinement(repoDir);
  const flagged = flag === undefined ? undefined : parseRoleFlag("refinement", flag, configured);
  if (flagged !== undefined && !flagged.ok) return flagged;
  const prompted =
    flagged === undefined && env.ask !== undefined
      ? (
          await env.ask(
            menuEntries({
              roles: ["refinement"],
              flagged: {},
              defaults: configured ? { refinement: configured } : {},
              defaultOrigin: () => "config",
            }),
            () => ({}),
          )
        ).refinement
      : undefined;
  const chosen = chooseRole({
    role: "refinement",
    ...(flagged?.ok ? { flag: flagged.choice } : {}),
    ...(prompted ? { prompted } : {}),
    ...(configured ? { fallback: configured } : {}),
  });
  if (!chosen.ok) return chosen;
  const problems = choiceProblems("refinement", chosen.choice);
  return problems.length > 0 ? { ok: false, problem: problems.join("; ") } : chosen;
}

async function configuredRefinement(repoDir: string): Promise<RoleChoice | undefined> {
  const present = await access(configPath(repoDir)).then(
    () => true,
    () => false,
  );
  return present ? (await loadConfig(repoDir)).roles.refinement : undefined;
}

async function init(args: string[], env: CliEnv): Promise<number> {
  if (args.length > 1) {
    env.err(USAGE);
    return 2;
  }
  const repoDir = resolve(env.cwd, args[0] ?? ".");
  if (await refused(repoDir, env)) return 1;
  try {
    for (const line of await initRepo(repoDir)) env.out(line);
    return 0;
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
  const repoDir = resolve(env.cwd, args[0] ?? ".");
  if (await refused(repoDir, env)) return 1;
  try {
    const { runs, unreadable } = await readRunEntries(join(repoDir, ".factory", "logs"));
    const abandoned = abandonedLogs(runs, env.clock.now());
    env.out(formatStats(summarizeRuns(runs.map((entry) => entry.log), abandoned), unreadable));
    return 0;
  } catch (error) {
    env.err(`factory: ${(error as Error).message}`);
    return 1;
  }
}
