import { parseEnv } from "node:util";
import { join } from "node:path";
import type { RunRole } from "../workers/agent-adapter.ts";
import { AGENT_KINDS, meetsRole } from "../workers/agents.ts";
import type { AgentKind } from "../workers/types.ts";

export type Credentials = Partial<Record<AgentKind, string>>;

export const CREDENTIAL_VARIABLES: Record<AgentKind, string> = {
  "claude-code": "CLAUDE_CODE_OAUTH_TOKEN",
  opencode: "OPENCODE_API_KEY",
};

export const CREDENTIAL_SOURCES = ["environment", "saved", "none"] as const;
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number];

const HOW_TO_GET: Record<AgentKind, string> = {
  "claude-code": "run `claude setup-token` with a Max plan",
  opencode: "create an OpenCode Go key, with Extra Usage turned off",
};

const CLAUDE_CODE_TOKEN_PREFIX = "sk-ant-oat";
const MIN_MASKED_LENGTH = 12;

export function credentialsFilePath(environment: { XDG_CONFIG_HOME?: string | undefined }, home: string): string {
  const configured = environment.XDG_CONFIG_HOME;
  const base = configured === undefined || configured === "" ? join(home, ".config") : configured;
  return join(base, "software-factory", "credentials");
}

export function credentialHow(agent: AgentKind): string {
  return HOW_TO_GET[agent];
}

export function credentialRoles(agent: AgentKind, roles: RunRole[]): RunRole[] {
  return roles.filter((role) => meetsRole(agent, role));
}

export function credentialHint(agent: AgentKind): string {
  return `${HOW_TO_GET[agent]}, then save it once for every target repo with \`factory auth ${agent}\`; ${CREDENTIAL_VARIABLES[agent]} in the environment wins over the saved one`;
}

export interface CredentialsProblem {
  problem: string;
  fix?: string;
}

export type SavedCredentials = { ok: true; values: Credentials } | ({ ok: false } & CredentialsProblem);

export function problemOf({ problem, fix }: CredentialsProblem): CredentialsProblem {
  return fix === undefined ? { problem } : { problem, fix };
}

export function parseCredentialsFile(text: string, path: string): SavedCredentials {
  const known = new Map(AGENT_KINDS.map((kind) => [CREDENTIAL_VARIABLES[kind], kind]));
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    const variable = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
    if (variable === undefined || !known.has(variable) || seen.has(variable)) {
      return {
        ok: false,
        problem: `${path} line ${index + 1} is not understood: it must be VARIABLE=value, once, with VARIABLE one of ${[...known.keys()].join(", ")}; fix the line or delete it`,
      };
    }
    seen.add(variable);
  }
  const parsed = parseEnv(text);
  const values: Credentials = {};
  for (const [variable, kind] of known) {
    if (!seen.has(variable)) continue;
    const value = parsed[variable];
    if (value === undefined || value === "") {
      return { ok: false, problem: `${path} has an empty value for ${variable}; set it with factory auth ${kind} or delete the line` };
    }
    values[kind] = value;
  }
  return { ok: true, values };
}

export function resolveCredentials(
  environment: Record<string, string | undefined>,
  saved: Credentials,
): Credentials {
  const resolved: Credentials = {};
  for (const kind of AGENT_KINDS) {
    const value = credentialValue(kind, environment, saved);
    if (value !== undefined) resolved[kind] = value;
  }
  return resolved;
}

export function credentialSource(
  agent: AgentKind,
  environment: Record<string, string | undefined>,
  saved: Credentials,
): CredentialSource {
  const fromEnvironment = environment[CREDENTIAL_VARIABLES[agent]];
  if (fromEnvironment !== undefined && fromEnvironment !== "") return "environment";
  return saved[agent] ? "saved" : "none";
}

function credentialValue(
  agent: AgentKind,
  environment: Record<string, string | undefined>,
  saved: Credentials,
): string | undefined {
  const source = credentialSource(agent, environment, saved);
  if (source === "environment") return environment[CREDENTIAL_VARIABLES[agent]];
  return source === "saved" ? saved[agent] : undefined;
}

export type CredentialCheck =
  | { kind: "accepted" }
  | { kind: "warning"; warning: string }
  | { kind: "rejected"; problem: string };

export function checkCredentialInput(agent: AgentKind, value: string): CredentialCheck {
  if (value === "") return { kind: "rejected", problem: "the credential is empty" };
  if (/\s/.test(value)) {
    return { kind: "rejected", problem: "the credential has a space or a line break, which would break the env file of the container" };
  }
  if (/[#"'`\\]/.test(value)) {
    return { kind: "rejected", problem: "the credential has a quote, a backtick, a backslash or a #: Node's env parser would truncate or unquote it, so the credentials file cannot hold it as it is" };
  }
  if (agent === "claude-code" && !value.startsWith(CLAUDE_CODE_TOKEN_PREFIX)) {
    return {
      kind: "warning",
      warning: `a Claude Code token from \`claude setup-token\` starts with ${CLAUDE_CODE_TOKEN_PREFIX}; this value does not`,
    };
  }
  return { kind: "accepted" };
}

export function replaceCredentialLine(text: string, variable: string, value: string): string {
  const line = `${variable}=${value}`;
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const at = lines.findIndex((existing) => existing.startsWith(`${variable}=`));
  if (at === -1) lines.push(line);
  else lines[at] = line;
  return `${lines.join("\n")}\n`;
}

export function removeCredentialLine(text: string, variable: string): string {
  const lines = text
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith(`${variable}=`));
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export function maskCredential(value: string): string {
  return value.length >= MIN_MASKED_LENGTH ? `…${value.slice(-4)}` : "…";
}

export function credentialOrigin(
  agent: AgentKind,
  environment: Record<string, string | undefined>,
  saved: Credentials,
): string {
  const source = credentialSource(agent, environment, saved);
  if (source === "environment") return "from environment (wins over saved)";
  const value = saved[agent];
  return source === "saved" && value !== undefined ? `saved (${maskCredential(value)})` : "not set";
}
