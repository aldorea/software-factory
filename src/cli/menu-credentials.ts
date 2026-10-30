import type { CredentialsProblem } from "../config/credentials.ts";
import { loadCredentials } from "../config/credentials-store.ts";
import { AGENT_KINDS } from "../workers/agents.ts";
import type { AgentKind } from "../workers/types.ts";
import { promptCredential } from "./auth.ts";
import type { CliEnv } from "./main.ts";
import type { MenuCredentials } from "./role-menu.ts";
import { reportFailure } from "./report.ts";

export function menuCredentials(env: Pick<CliEnv, "auth" | "credentials" | "out" | "err" | "color" | "errColor">): MenuCredentials | undefined {
  const input = env.auth;
  if (input === undefined) return undefined;
  const missing = AGENT_KINDS.filter((agent) => !env.credentials[agent]);
  const fail = (failure: CredentialsProblem) => {
    reportFailure(failure, env);
    return false;
  };
  return {
    missing,
    async add(agent: AgentKind) {
      try {
        const outcome = await promptCredential(agent, input, env);
        if (outcome.kind === "cancelled") return false;
        if (outcome.kind !== "saved") return fail(outcome);
        const loaded = await loadCredentials(outcome.path, input.environment);
        if (!loaded.ok) return fail(loaded);
        const value = loaded.credentials[agent];
        if (value === undefined) return fail({ problem: `${agent} has no credential after saving it` });
        env.credentials[agent] = value;
        return true;
      } catch (error) {
        return fail({ problem: (error as Error).message });
      }
    },
  };
}
