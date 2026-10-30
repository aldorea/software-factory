import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";

export interface EnvFacts {
  variables: string[];
  values: Record<string, string | undefined> | null;
}

async function readEnvFile(file: string): Promise<Record<string, string | undefined> | null> {
  try {
    return parseEnv(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export async function readEnvFacts(repoDir: string): Promise<EnvFacts> {
  const example = await readEnvFile(join(repoDir, ".factory", ".env.example"));
  return { variables: Object.keys(example ?? {}), values: await readEnvFile(join(repoDir, ".factory", ".env")) };
}
