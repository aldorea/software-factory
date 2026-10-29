import type { AgentAdapter, AgentCapabilities, Role } from "./agent-adapter.ts";
import { claudeCodeAdapter } from "./claude-code.ts";
import { openCodeAdapter } from "./opencode.ts";
import type { AgentKind } from "./types.ts";

const ADAPTERS: Record<AgentKind, AgentAdapter> = {
  "claude-code": claudeCodeAdapter,
  opencode: openCodeAdapter,
};

export const AGENT_KINDS: AgentKind[] = ["claude-code", "opencode"];

export const ROLE_REQUIREMENTS: Record<Role, (keyof AgentCapabilities)[]> = {
  workers: ["readsTokenUsage", "detectsPlanLimit"],
  verifier: ["deniesEveryTool"],
  tester: ["readsTokenUsage"],
  refinement: ["startsInteractiveSession"],
};

export function adapterFor(kind: AgentKind): AgentAdapter {
  return ADAPTERS[kind];
}

export function missingRequirements(kind: AgentKind, role: Role): (keyof AgentCapabilities)[] {
  return unmetRequirements(ADAPTERS[kind].capabilities, role);
}

export function unmetRequirements(capabilities: AgentCapabilities, role: Role): (keyof AgentCapabilities)[] {
  return ROLE_REQUIREMENTS[role].filter((requirement) => !capabilities[requirement]);
}

export function meetsRole(kind: AgentKind, role: Role): boolean {
  return missingRequirements(kind, role).length === 0;
}

export function agentsForRole(role: Role): AgentKind[] {
  return AGENT_KINDS.filter((kind) => meetsRole(kind, role));
}
