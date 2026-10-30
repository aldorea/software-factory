import { loadCredentials } from "../config/credentials-store.ts";
import { AGENT_KINDS } from "../workers/agents.ts";
import type { AgentKind } from "../workers/types.ts";
import { promptCredential } from "./auth.ts";
import type { CliEnv } from "./main.ts";
import type { MenuCredentials } from "./role-menu.ts";
import { renderSetup } from "./setup-render.ts";

export function menuCredentials(env: CliEnv): MenuCredentials | undefined {
  const input = env.auth;
  if (input === undefined) return undefined;
  const missing = AGENT_KINDS.filter((agent) => !env.credentials[agent]);
  const fail = (text: string) => {
    for (const line of renderSetup([{ kind: "fail", text: `factory: ${text}` }], env.color === true)) env.err(line);
    return false;
  };
  return {
    missing,
    async add(agent: AgentKind) {
      const outcome = await promptCredential(agent, input, env);
      if (outcome.kind === "cancelled") return false;
      if (outcome.kind !== "saved") return fail(outcome.problem);
      const loaded = await loadCredentials(outcome.path, input.environment);
      if (!loaded.ok) return fail(loaded.problem);
      const value = loaded.credentials[agent];
      if (value === undefined) return fail(`${agent} has no credential after saving it`);
      env.credentials[agent] = value;
      return true;
    },
  };
}
