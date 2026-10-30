import type { Role, RoleChoice } from "../config/config.ts";
import { CREDENTIAL_VARIABLES, ROLES } from "../config/roles.ts";
import { AGENT_KINDS } from "../workers/agents.ts";
import type { AgentKind } from "../workers/types.ts";
import type { SetupLine } from "./setup-render.ts";

export type ReadinessCommand = "refine" | "run" | "doctor";

export type ProbeName = "docker" | "gh" | "claudeSession" | "originHead" | "workerImage" | "node" | "config";

export type Probes = Record<ProbeName, () => Promise<string | null>>;

export interface ReadinessFacts {
  probes: Partial<Record<ProbeName, string | null>>;
  roles: Partial<Record<Role, RoleChoice>>;
  credentials: Partial<Record<AgentKind, string>>;
  credentialsProblem?: string | null;
  env?: EnvFacts;
}

export interface EnvFacts {
  variables: string[];
  values: Record<string, string | undefined> | null;
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

const CHMOD_FIX = /^(.*); run (chmod 600 .+)$/s;

function credentialsFileFailure(problem: string): CheckResult {
  const split = CHMOD_FIX.exec(problem);
  return split === null ? { kind: "fail", text: problem } : { kind: "fail", text: split[1] as string, command: split[2] as string };
}

const credentialCheck: Check = {
  commands: ["run", "doctor"],
  needs: [],
  evaluate({ roles, credentials, credentialsProblem }) {
    if (credentialsProblem) return [credentialsFileFailure(credentialsProblem)];
    const results: CheckResult[] = [];
    for (const agent of AGENT_KINDS) {
      const users = ROLES.filter((role) => roles[role]?.agent === agent);
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

const envFileCheck: Check = {
  commands: ["doctor"],
  needs: [],
  evaluate({ env }) {
    if (env === undefined) throw new Error("the .env facts were not read before the .env readiness check");
    if (env.variables.length === 0) return [];
    if (env.values === null) {
      return [
        {
          kind: "fail",
          text: `.factory/.env does not exist; .factory/.env.example lists ${env.variables.join(", ")}`,
          command: "cp .factory/.env.example .factory/.env",
        },
      ];
    }
    const values = env.values;
    const empty = env.variables.filter((name) => (values[name] ?? "") === "");
    if (empty.length === 0) return [{ kind: "ok", text: ".factory/.env has every value of .factory/.env.example" }];
    return [{ kind: "fail", text: `.factory/.env has no value for ${empty.join(", ")}`, command: "edit .factory/.env" }];
  },
};

const workerImageCheck: Check = {
  commands: ["run", "doctor"],
  needs: ["docker", "workerImage"],
  evaluate(facts) {
    if (probed(facts, "docker") !== null) return [];
    if (facts.probes.config) return [];
    const problem = probed(facts, "workerImage");
    if (problem === null) return [{ kind: "ok", text: "the worker image is built from the current base image" }];
    return [{ kind: "fail", text: problem, command: "factory image" }];
  },
};

export const CHECKS: Check[] = [
  probeCheck("node", ["doctor"], "Node is at the floor of engines in package.json", undefined),
  probeCheck("docker", ["run", "doctor"], "Docker is running", undefined),
  probeCheck("gh", ["refine", "run", "doctor"], "gh is signed in", "gh auth login"),
  probeCheck("claudeSession", ["refine", "doctor"], "the Claude Code session of the host is signed in", "claude auth login"),
  probeCheck("config", ["doctor"], ".factory/config.ts loads", undefined),
  envFileCheck,
  probeCheck("originHead", ["refine", "doctor"], "origin/HEAD is set", "git remote set-head origin --auto"),
  credentialCheck,
  workerImageCheck,
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

export function readinessLines(results: CheckResult[]): SetupLine[] {
  return results.map(
    (result): SetupLine => ({
      kind: result.kind,
      text: result.text,
      ...(result.command !== undefined ? { command: result.command } : {}),
    }),
  );
}

export function readinessProblems(results: CheckResult[]): SetupLine[] {
  return results.flatMap((result): SetupLine[] =>
    result.kind === "fail"
      ? [{ kind: "fail", text: result.text, ...(result.command !== undefined ? { command: result.command } : {}) }]
      : [],
  );
}
