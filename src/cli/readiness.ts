import type { Role, RoleChoice } from "../config/config.ts";
import { CONFIGURED_ROLES, CREDENTIAL_VARIABLES } from "../config/roles.ts";
import { AGENT_KINDS } from "../workers/agents.ts";
import type { AgentKind } from "../workers/types.ts";
import type { SetupLine } from "./setup-render.ts";

export type ReadinessCommand = "refine" | "run";

export type ProbeName = "docker" | "gh" | "claudeSession" | "originHead";

export type Probes = Record<ProbeName, () => Promise<string | null>>;

export interface ReadinessFacts {
  probes: Partial<Record<ProbeName, string | null>>;
  roles: Partial<Record<Role, RoleChoice>>;
  credentials: Partial<Record<AgentKind, string>>;
}

export interface CheckResult {
  kind: "ok" | "fail";
  text: string;
  command?: string;
}

interface Check {
  commands: ReadinessCommand[];
  needs: ProbeName[];
  evaluate(facts: ReadinessFacts): CheckResult[];
}

function probed(facts: ReadinessFacts, name: ProbeName): string | null {
  const problem = facts.probes[name];
  if (problem === undefined) throw new Error(`the ${name} probe was not run before its readiness check`);
  return problem;
}

function probeCheck(
  name: ProbeName,
  commands: ReadinessCommand[],
  passed: string,
  fix: string | undefined,
): Check {
  return {
    commands,
    needs: [name],
    evaluate(facts) {
      const problem = probed(facts, name);
      if (problem === null) return [{ kind: "ok", text: passed }];
      return [{ kind: "fail", text: problem, ...(fix !== undefined ? { command: fix } : {}) }];
    },
  };
}

function roleList(roles: Role[]): string {
  const names = roles.map((role) => `roles.${role}`);
  return names.length === 1 ? `${names[0]} uses` : `${names.slice(0, -1).join(", ")} and ${names.at(-1)} use`;
}

const credentialCheck: Check = {
  commands: ["run"],
  needs: [],
  evaluate({ roles, credentials }) {
    const results: CheckResult[] = [];
    for (const agent of AGENT_KINDS) {
      const users = CONFIGURED_ROLES.filter((role) => roles[role]?.agent === agent);
      if (users.length === 0) continue;
      const variable = CREDENTIAL_VARIABLES[agent];
      if (credentials[agent]) {
        results.push({ kind: "ok", text: `${variable} is set for ${agent}` });
      } else {
        results.push({
          kind: "fail",
          text: `${variable} not set; ${roleList(users)} ${agent}`,
          command: `factory auth ${agent}`,
        });
      }
    }
    return results;
  },
};

export const CHECKS: Check[] = [
  probeCheck("docker", ["run"], "Docker is running", undefined),
  probeCheck("gh", ["refine", "run"], "gh is signed in", "gh auth login"),
  probeCheck("claudeSession", ["refine"], "the Claude Code session of the host is signed in", "claude auth login"),
  probeCheck("originHead", ["refine"], "origin/HEAD is set", "git remote set-head origin --auto"),
  credentialCheck,
];

function checksOf(command: ReadinessCommand): Check[] {
  return CHECKS.filter((check) => check.commands.includes(command));
}

export function neededProbes(command: ReadinessCommand): ProbeName[] {
  return [...new Set(checksOf(command).flatMap((check) => check.needs))];
}

export async function gatherProbes(command: ReadinessCommand, probes: Probes): Promise<ReadinessFacts["probes"]> {
  const names = neededProbes(command);
  const found = await Promise.all(names.map((name) => probes[name]()));
  return Object.fromEntries(names.map((name, index) => [name, found[index]]));
}

export function readiness(command: ReadinessCommand, facts: ReadinessFacts): CheckResult[] {
  return checksOf(command).flatMap((check) => check.evaluate(facts));
}

export function readinessProblems(results: CheckResult[]): SetupLine[] {
  return results.flatMap((result): SetupLine[] =>
    result.kind === "fail"
      ? [{ kind: "fail", text: result.text, ...(result.command !== undefined ? { command: result.command } : {}) }]
      : [],
  );
}
