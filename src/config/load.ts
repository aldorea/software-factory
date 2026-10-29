import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_LIMITS, resolveConfig, type ResolvedConfig } from "./config.ts";

export function configPath(repoDir: string): string {
  return join(repoDir, ".factory", "config.ts");
}

export async function attemptIdleTimeoutMs(repoDir: string): Promise<number> {
  const configured = await access(configPath(repoDir)).then(
    () => true,
    () => false,
  );
  return configured ? (await loadConfig(repoDir)).limits.attemptIdleTimeoutMs : DEFAULT_LIMITS.run.attemptIdleTimeoutMs;
}

let loads = 0;

export async function loadConfig(repoDir: string): Promise<ResolvedConfig> {
  const file = configPath(repoDir);
  try {
    await access(file);
  } catch {
    throw new Error(`${file} does not exist; every target repo needs a .factory/config.ts`);
  }
  loads += 1;
  const url = `${pathToFileURL(file).href}?mtime=${(await stat(file)).mtimeMs}&load=${loads}`;
  let module: { default?: unknown };
  try {
    module = (await import(url)) as { default?: unknown };
  } catch (error) {
    throw new Error(`${file} does not load: ${(error as Error).message}`);
  }
  const result = resolveConfig(module.default);
  if (!result.ok) {
    throw new Error([`${file} is invalid:`, ...result.problems.map((problem) => `- ${problem}`)].join("\n"));
  }
  return result.config;
}
