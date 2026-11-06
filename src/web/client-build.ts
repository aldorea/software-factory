import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const BUILD_MANIFEST = "build.json";
export const BUILD_FIX = "pnpm build:web";

export interface BuildManifest {
  sourceHash: string;
}

export function clientSourceDir(factoryRoot: string): string {
  return join(factoryRoot, "src", "web", "client");
}

export function clientBuildDir(factoryRoot: string): string {
  return join(factoryRoot, "dist", "web");
}

async function sourceFiles(sourceDir: string): Promise<string[]> {
  const entries = await readdir(sourceDir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(sourceDir, join(entry.parentPath, entry.name)).split(sep))
    .filter((segments) => !segments.some((segment) => segment.startsWith(".")))
    .map((segments) => segments.join("/"))
    .sort();
}

export async function hashClientSources(sourceDir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await sourceFiles(sourceDir)) {
    const content = await readFile(join(sourceDir, ...file.split("/")));
    hash.update(`${file}\0${content.length}\0`);
    hash.update(content);
  }
  return hash.digest("hex");
}

export async function writeBuildManifest(buildDir: string, sourceHash: string): Promise<void> {
  await mkdir(buildDir, { recursive: true });
  const manifest: BuildManifest = { sourceHash };
  const file = join(buildDir, BUILD_MANIFEST);
  await writeFile(`${file}.tmp`, `${JSON.stringify(manifest)}\n`);
  await rename(`${file}.tmp`, file);
}

async function readManifestHash(buildDir: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(join(buildDir, BUILD_MANIFEST), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const hash = (JSON.parse(text) as Partial<BuildManifest>).sourceHash;
    return typeof hash === "string" ? hash : null;
  } catch {
    return null;
  }
}

export async function clientBuildProblem(factoryRoot: string): Promise<string | null> {
  const buildDir = clientBuildDir(factoryRoot);
  const built = await readManifestHash(buildDir);
  if (built === null) return `the web client is not built: ${join(buildDir, BUILD_MANIFEST)} is missing or unreadable`;
  if (built !== (await hashClientSources(clientSourceDir(factoryRoot)))) {
    return "the build of the web client comes from older sources than the current ones";
  }
  return null;
}
