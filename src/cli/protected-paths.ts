import { access } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function readProtectedPaths(repoDir: string): Promise<string[]> {
  const file = join(repoDir, ".factory", "config.ts");
  try {
    await access(file);
  } catch {
    throw new Error(`${file} does not exist; the protected paths of the target repo are needed to validate a spec`);
  }
  const module = (await import(pathToFileURL(file).href)) as { default?: { protectedPaths?: unknown } };
  const paths = module.default?.protectedPaths;
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string")) {
    throw new Error(`${file}: protectedPaths must be a list of strings`);
  }
  return paths;
}
