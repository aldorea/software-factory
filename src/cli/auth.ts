import {
  checkCredentialInput,
  credentialHint,
  credentialHow,
  credentialRoles,
  CREDENTIAL_VARIABLES,
} from "../config/credentials.ts";
import { saveCredential } from "../config/credentials-store.ts";
import { isAgentKind, ROLES } from "../config/roles.ts";
import { AGENT_KINDS } from "../workers/agents.ts";
import type { AgentKind } from "../workers/types.ts";
import { runAuthMenu, type MenuScreen } from "./auth-menu.ts";
import type { CliEnv } from "./main.ts";
import { renderSetup, type SetupLine } from "./setup-render.ts";

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
  | { kind: "rejected" | "declined" | "failed"; problem: string };

type AuthEnv = Pick<CliEnv, "out" | "err" | "color">;

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
    `usage: ${AUTH_USAGE}   (agents: ${AGENT_KINDS.join(", ")})`,
    "       pbpaste | factory auth <agent>   reads one line from stdin when there is no terminal",
    ...AGENT_KINDS.map((agent) => `  ${agent}: ${CREDENTIAL_VARIABLES[agent]}; ${credentialHint(agent)}`),
  ];
}

export async function promptCredential(agent: AgentKind, input: AuthInput, env: AuthEnv): Promise<PromptOutcome> {
  const color = env.color === true;
  const print = (lines: SetupLine[]) => {
    for (const line of renderSetup(lines, color)) env.out(line);
  };
  if (input.terminal) print(credentialExplanation(agent, input.credentialsPath));
  const value = await input.readSecret(input.terminal ? "Paste the credential (it is not shown): " : "");
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
  if (!saved.ok) return { kind: "failed", problem: saved.problem };
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
  const fail = (text: string) => {
    for (const line of renderSetup([{ kind: "fail", text: `factory: ${text}` }], env.color === true)) env.err(line);
    return 1;
  };
  if (args.length === 0 && env.auth?.terminal === true && env.auth.screen !== undefined) {
    const { credentialsPath, environment, screen } = env.auth;
    const menu = await runAuthMenu({
      credentialsPath,
      environment,
      screen,
      color: env.color === true,
      prompt: (agent) => promptCredential(agent, env.auth as AuthInput, env),
    });
    return menu.ok ? 0 : fail(menu.problem);
  }
  if (args.length === 0 || (args.length === 1 && (args[0] === "--help" || args[0] === "-h"))) {
    for (const line of authHelp()) env.out(line);
    return 0;
  }
  const [agent, ...rest] = args as [string, ...string[]];
  if (rest.length > 0) {
    env.err(authHelp()[0] as string);
    return 2;
  }
  if (!isAgentKind(agent)) return fail(`${agent} is not an agent: use one of ${AGENT_KINDS.join(", ")}`);
  if (env.auth === undefined) return fail("factory auth is not available here");
  const outcome = await promptCredential(agent, env.auth, env);
  if (outcome.kind === "saved") return 0;
  if (outcome.kind === "cancelled") return fail(env.auth.terminal ? "cancelled; nothing was saved" : "no credential on stdin");
  return fail(outcome.problem);
}
