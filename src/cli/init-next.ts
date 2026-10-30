import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { RoleChoice } from "../config/config.ts";
import { loadConfig } from "../config/load.ts";
import { imageName } from "../init/plan.ts";
import { DEFAULT_ROLES } from "../init/templates.ts";
import type { AgentKind } from "../workers/types.ts";
import type { CliEnv } from "./main.ts";
import { nextSteps } from "./next-steps.ts";
import type { SetupLine } from "./setup-render.ts";

export async function readEnvFile(file: string): Promise<Record<string, string | undefined> | null> {
  try {
    return parseEnv(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function configFacts(repoDir: string): Promise<{ image: string; roles: RoleChoice[] }> {
  const fallback = { image: imageName(repoDir), roles: Object.values(DEFAULT_ROLES) };
  try {
    const config = await loadConfig(repoDir);
    const roles = Object.values(config.roles);
    return { image: config.image, roles: roles.length > 0 ? roles : fallback.roles };
  } catch {
    return fallback;
  }
}

async function imagePresent(env: Pick<CliEnv, "images">, image: string): Promise<boolean> {
  try {
    return (await env.images.id(image)) !== null;
  } catch {
    return false;
  }
}

export async function nextStepsOf(repoDir: string, env: Pick<CliEnv, "images" | "credentials">): Promise<SetupLine[]> {
  const { image, roles } = await configFacts(repoDir);
  const example = await readEnvFile(join(repoDir, ".factory", ".env.example"));
  const agents: AgentKind[] = [...new Set(roles.map((role) => role.agent))];
  return nextSteps({
    image,
    envVariables: Object.keys(example ?? {}),
    envValues: await readEnvFile(join(repoDir, ".factory", ".env")),
    agents,
    credentials: env.credentials,
    workerImagePresent: await imagePresent(env, image),
  });
}
