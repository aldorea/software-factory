import { authRows } from "../cli/auth-menu.ts";
import { credentialHow, credentialRoles, problemOf, type CredentialsProblem } from "../config/credentials.ts";
import { readSavedCredentials } from "../config/credentials-store.ts";
import { ROLES } from "../config/roles.ts";
import type { AgentKind } from "../workers/types.ts";

export interface AuthAgent {
  agent: AgentKind;
  variable: string;
  origin: string;
  how: string;
  roles: string[];
}

export interface AuthPage {
  agents: AuthAgent[];
  path: string | null;
  problem: CredentialsProblem | null;
}

export interface CredentialsSource {
  path: string;
  environment: Record<string, string | undefined>;
}

export async function authPage(source: CredentialsSource | undefined): Promise<AuthPage> {
  const saved = source === undefined ? { ok: true as const, values: {} } : await readSavedCredentials(source.path);
  const rows = authRows(source?.environment ?? {}, saved.ok ? saved.values : {});
  return {
    agents: rows.map(({ agent, variable, origin }) => ({ agent, variable, origin, how: credentialHow(agent), roles: credentialRoles(agent, ROLES) })),
    path: source?.path ?? null,
    problem: saved.ok ? null : problemOf(saved),
  };
}
