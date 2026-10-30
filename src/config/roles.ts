import type { Role, RunRole } from "../workers/agent-adapter.ts";
import { AGENT_KINDS, missingRequirements } from "../workers/agents.ts";
import type { AgentKind } from "../workers/types.ts";
import type { RoleChoice } from "./config.ts";
import { credentialHint, CREDENTIAL_VARIABLES } from "./credentials.ts";

export const ROLES: RunRole[] = ["workers", "verifier", "tester"];

export const CONFIGURED_ROLES: Role[] = [...ROLES, "refinement"];

export const ROLE_FLAGS: Record<Role, string> = {
  workers: "--worker-agent",
  verifier: "--verifier-agent",
  tester: "--tester-agent",
  refinement: "--refinement-agent",
};

export type ChosenRole = { ok: true; choice: RoleChoice } | { ok: false; problem: string };

export interface RoleSources {
  role: Role;
  flag?: RoleChoice;
  prompted?: RoleChoice;
  fallback?: RoleChoice;
}

export function chooseRole({ role, flag, prompted, fallback }: RoleSources): ChosenRole {
  const choice = flag ?? prompted ?? fallback;
  if (choice !== undefined) return { ok: true, choice };
  return {
    ok: false,
    problem: `no agent for the ${role}: pass ${ROLE_FLAGS[role]} <agent>:<model> or set roles.${role} in .factory/config.ts`,
  };
}

export function isAgentKind(value: string): value is AgentKind {
  return (AGENT_KINDS as string[]).includes(value);
}

export function parseRoleFlag(role: Role, value: string, fallback?: RoleChoice): ChosenRole {
  const separator = value.indexOf(":");
  const agent = separator === -1 ? value : value.slice(0, separator);
  const model = separator === -1 ? "" : value.slice(separator + 1);
  if (!isAgentKind(agent)) return { ok: false, problem: `${agent} is not an agent: use one of ${AGENT_KINDS.join(", ")}` };
  if (model.trim() !== "") return { ok: true, choice: { agent, model } };
  if (fallback !== undefined && fallback.agent === agent) return { ok: true, choice: fallback };
  return { ok: false, problem: `${ROLE_FLAGS[role]} ${agent} needs a model: pass ${ROLE_FLAGS[role]} ${agent}:<model>` };
}

export function choiceProblems(role: Role, choice: RoleChoice): string[] {
  const missing = missingRequirements(choice.agent, role);
  if (missing.length > 0) return [`${choice.agent} cannot serve the ${role}: it misses ${missing.join(", ")}`];
  if (choice.agent === "opencode" && !choice.model.startsWith("opencode-go/")) {
    return [`the ${role} model must be an opencode-go/ model: other OpenCode providers are pay per use`];
  }
  return [];
}

export function credentialProblem(
  role: Role,
  choice: RoleChoice,
  credentials: Partial<Record<AgentKind, string>>,
): string | null {
  if (credentials[choice.agent]) return null;
  return `${CREDENTIAL_VARIABLES[choice.agent]} is not set; the ${choice.agent} ${role} needs it: ${credentialHint(choice.agent)}`;
}
