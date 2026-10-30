import { resolve } from "node:path";
import { loadConfig } from "../config/load.ts";
import { envProbes } from "./env-probes.ts";
import { readDockerignore, readEnvFacts } from "./env-facts.ts";
import type { CliEnv } from "./main.ts";
import { gatherProbes, readiness, readinessLines } from "./readiness.ts";
import { reportOut } from "./report.ts";
import { refused } from "./target-repo.ts";

export async function doctor(args: string[], env: CliEnv, usage: string): Promise<number> {
  if (args.length > 1) {
    env.err(usage);
    return 2;
  }
  const repoDir = resolve(env.cwd, args[0] ?? ".");
  if (await refused(repoDir, env)) return 1;
  try {
    const loaded = await loadConfig(repoDir).then(
      (config) => ({ ok: true as const, config }),
      (error: unknown) => ({ ok: false as const, problem: (error as Error).message }),
    );
    const config = loaded.ok ? loaded.config : null;
    const probes = await gatherProbes("doctor", {
      ...envProbes(repoDir, env, config?.image ?? null),
      config: async () => (loaded.ok ? null : loaded.problem),
    });
    const results = readiness("doctor", {
      probes,
      roles: config?.roles ?? {},
      credentials: env.credentials,
      credentialsProblem: env.credentialsProblem ?? null,
      env: await readEnvFacts(repoDir),
      dockerignore: await readDockerignore(repoDir),
    });
    reportOut(readinessLines(results), env);
    return results.some((result) => result.kind === "fail") ? 1 : 0;
  } catch (error) {
    env.err(`factory: ${(error as Error).message}`);
    return 1;
  }
}
