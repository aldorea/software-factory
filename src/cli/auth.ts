import {
  checkCredentialInput,
  credentialHint,
  credentialHow,
  credentialRoles,
  CREDENTIAL_VARIABLES,
  problemOf,
} from "../config/credentials.ts";
import { saveCredential } from "../config/credentials-store.ts";
import { isAgentKind, ROLES } from "../config/roles.ts";
import { AGENT_KINDS } from "../workers/agents.ts";
import type { AgentKind } from "../workers/types.ts";
import { showAuthMenu, type MenuScreen } from "./auth-menu.ts";
import type { CliEnv } from "./main.ts";
import { reportFailure, reportOut, type Reporter } from "./report.ts";
import type { SetupLine } from "./setup-render.ts";

export const AUTH_USAGE = "factory auth <agent>";

export interface AuthInput {
  credentialsPath: string;
  environment: Record<string, string | undefined>;
  terminal: boolean;
  screen?: MenuScreen;
  readSecret(prompt: string): Promise<string | null>;
  confirm(question: string): Promise<boolean>;
}

export type PromptOutcome =
  | { kind: "saved"; path: string }
  | { kind: "cancelled" }
  | { kind: "rejected" | "declined"; problem: string }
  | { kind: "failed"; problem: string; fix?: string };

const SECRET_PROMPT = "Paste the credential (it is not shown): ";

export const AUTH_USAGE_LINE = `usage: ${AUTH_USAGE}   (agents: ${AGENT_KINDS.join(", ")})`;

export function credentialExplanation(agent: AgentKind, path: string): SetupLine[] {
  const variable = CREDENTIAL_VARIABLES[agent];
  return [
    { kind: "title", text: `Credential of ${agent} (${variable})` },
    {
      kind: "text",
      text: `It lets ${agent} run on your subscription inside a container. Roles that use it: ${credentialRoles(agent, ROLES).join(", ")}.`,
    },
    { kind: "text", text: `How to get it: ${credentialHow(agent)}.` },
    { kind: "text", text: `It is saved in ${path} and it serves every target repo.` },
    { kind: "text", text: `If ${variable} is set in the environment, it wins over the saved one.` },
  ];
}

export function authHelp(): string[] {
  return [
    AUTH_USAGE_LINE,
    "       pbpaste | factory auth <agent>   reads one line from stdin when there is no terminal",
    ...AGENT_KINDS.map((agent) => `  ${agent}: ${CREDENTIAL_VARIABLES[agent]}; ${credentialHint(agent)}`),
  ];
}

export async function promptCredential(agent: AgentKind, input: AuthInput, env: Reporter): Promise<PromptOutcome> {
  const print = (lines: SetupLine[]) => reportOut(lines, env);
  if (input.terminal) print(credentialExplanation(agent, input.credentialsPath));
  const value = await input.readSecret(SECRET_PROMPT);
  if (value === null) return { kind: "cancelled" };
  const checked = checkCredentialInput(agent, value);
  if (checked.kind === "rejected") return { kind: "rejected", problem: checked.problem };
  if (checked.kind === "warning") {
    if (!input.terminal) {
      return { kind: "declined", problem: `${checked.warning}; with no terminal there is nobody to confirm, so nothing was saved` };
    }
    print([{ kind: "warn", text: checked.warning }]);
    if (!(await input.confirm("Save it anyway? [y/N] "))) return { kind: "declined", problem: "nothing was saved" };
  }
  const saved = await saveCredential(input.credentialsPath, agent, value);
  if (!saved.ok) return { kind: "failed", ...problemOf(saved) };
  const variable = CREDENTIAL_VARIABLES[agent];
  const lines: SetupLine[] = [{ kind: "ok", text: `saved ${variable} in ${saved.path}; it serves every target repo` }];
  const fromEnvironment = input.environment[variable];
  if (fromEnvironment !== undefined && fromEnvironment !== "") {
    lines.push({ kind: "warn", text: `${variable} is set in the environment and wins over the saved one` });
  }
  print(lines);
  return { kind: "saved", path: saved.path };
}

export async function auth(args: string[], env: CliEnv): Promise<number> {
  const fail = (problem: string) => {
    reportFailure({ problem }, env);
    return 1;
  };
  const credential = env.auth;
  if (args.length === 0 && credential?.terminal === true && credential.screen !== undefined) {
    const { credentialsPath, environment, screen } = credential;
    const menu = await showAuthMenu({
      credentialsPath,
      environment,
      screen,
      color: env.color === true,
      prompt: (agent) => promptCredential(agent, credential, env),
    });
    if (menu.ok) return 0;
    reportFailure(menu, env);
    return 1;
  }
  const [agent, ...rest] = args;
  if (agent === undefined || (rest.length === 0 && (agent === "--help" || agent === "-h"))) {
    for (const line of authHelp()) env.out(line);
    return 0;
  }
  if (rest.length > 0) {
    env.err(AUTH_USAGE_LINE);
    return 2;
  }
  if (!isAgentKind(agent)) return fail(`${agent} is not an agent: use one of ${AGENT_KINDS.join(", ")}`);
  if (credential === undefined) return fail("factory auth is not available here");
  const outcome = await promptCredential(agent, credential, env);
  if (outcome.kind === "saved") return 0;
  if (outcome.kind === "cancelled") return fail(credential.terminal ? "cancelled; nothing was saved" : "no credential on stdin");
  reportFailure(outcome, env);
  return 1;
}
