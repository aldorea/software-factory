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
import type { ImageDocker } from "../workers/images.ts";
import type { AgentKind, WorkerRunner } from "../workers/types.ts";
import { activityLine } from "./activity-line.ts";
import { auth, AUTH_USAGE, type AuthInput } from "./auth.ts";
import { clockMinutes } from "./clock-time.ts";
import { image } from "./image.ts";
import { nextStepsOf } from "./init-next.ts";
import type { InteractiveLaunch } from "./launch.ts";
import { planLimitAnnotate } from "./plan-limit-warning.ts";
import { menuCredentials } from "./menu-credentials.ts";
import { menuEntries, type Annotate, type MenuCredentials, type RoleEntry } from "./role-menu.ts";
import { gatherProbes, readiness, readinessProblems, type Probes } from "./readiness.ts";
import { renderSetup, type SetupLine } from "./setup-render.ts";
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
  claudeSession(): Promise<string | null>;
  originHead(repoDir: string): Promise<string | null>;
  ask?: (
    entries: RoleEntry[],
    annotate: Annotate,
    credentials?: MenuCredentials,
  ) => Promise<Partial<Record<Role, RoleChoice>>>;
  terminal?: { columns(): number; write(text: string): void };
  launch(launch: InteractiveLaunch): Promise<number>;
  images: ImageDocker;
  signal: AbortSignal;
  auth?: AuthInput;
  color?: boolean;
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
  `       ${AUTH_USAGE}`,
  "       factory image [target-repo]",
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
  if (args[0] === "image") return image(args.slice(1), env, USAGE);
  if (args[0] === "web") return web(args.slice(1), env, USAGE);
  if (args[0] === "auth") return auth(args.slice(1), env);
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

function reportProblems(lines: SetupLine[], env: CliEnv): boolean {
  for (const line of renderSetup(lines, env.color === true)) env.err(line);
  return lines.length > 0;
}

function envProbes(repoDir: string, env: CliEnv): Probes {
  return {
    docker: () => env.docker(),
    gh: () => env.gh(),
    claudeSession: () => env.claudeSession(),
    originHead: () => env.originHead(repoDir),
  };
}

async function run(repoDir: string, issue: number, flags: RoleFlags, env: CliEnv): Promise<number> {
  const probes = await gatherProbes("run", envProbes(repoDir, env));
  const loaded = await loadConfig(repoDir).then(
    (config) => ({ ok: true as const, config }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const latest = await latestRunEntry(join(repoDir, ".factory", "logs"), issue);
  const previous = latest?.log ?? null;
  const defaults = loaded.ok ? resumeDefaults(previous, loaded.config.roles) : {};
  const flagged: Partial<Record<RunRole, RoleChoice>> = {};
  const flagProblems: SetupLine[] = [];
  for (const role of ROLES) {
    const flag = flags[role];
    if (flag === undefined) continue;
    const parsed = parseRoleFlag(role, flag, defaults[role]);
    if (parsed.ok) flagged[role] = parsed.choice;
    else flagProblems.push({ kind: "fail", text: parsed.problem });
  }
  const beforeMenu = readiness("run", { probes, roles: { ...defaults, ...flagged }, credentials: env.credentials });
  if (reportProblems([...readinessProblems(beforeMenu), ...flagProblems], env)) return 1;
  if (!loaded.ok) throw loaded.error;
  const config = loaded.config;
  if (latest !== null && runAbandoned(latest, env.clock.now())) {
    env.out(`run ${latest.log.runId} of #${issue} was abandoned at ${clockMinutes(lastChange(latest))}; starting a new run`);
  }
  const prompted =
    env.ask === undefined
      ? {}
      : await env.ask(
          menuEntries({ roles: ROLES, flagged, defaults, defaultOrigin: (role) => defaultOrigin(previous, role) }),
          planLimitAnnotate(previous, env.clock.now()),
          menuCredentials(env),
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
  const afterMenu = readiness("run", { probes, roles, credentials: env.credentials });
  if (reportProblems(readinessProblems(afterMenu), env)) return 1;
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
    const probes = await gatherProbes("refine", envProbes(repoDir, env));
    const ready = readiness("refine", { probes, roles: {}, credentials: env.credentials });
    if (reportProblems(readinessProblems(ready), env)) return 1;
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
    const written = await initRepo(repoDir);
    const lines: SetupLine[] = [
      ...written.map((text): SetupLine => ({ kind: "ok", text })),
      ...(await nextStepsOf(repoDir, env)),
    ];
    for (const line of renderSetup(lines, env.color === true)) {
      env.out(line);
    }
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
