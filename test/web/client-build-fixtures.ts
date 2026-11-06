import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clientBuildDir, clientSourceDir, hashClientSources, writeBuildManifest } from "../../src/web/client-build.ts";
import { CLIENT_DIR } from "./web-helpers.ts";

export type BuildState = "built" | "stale" | "missing";

export async function writeClientSources(factoryRoot: string, main = "export const app = 1;\n"): Promise<void> {
  const sources = clientSourceDir(factoryRoot);
  await mkdir(join(sources, "app"), { recursive: true });
  await writeFile(join(sources, "index.html"), "<div id=root></div>\n");
  await writeFile(join(sources, "app", "main.tsx"), main);
}

export async function writeClientBuild(factoryRoot: string, state: BuildState = "built"): Promise<void> {
  await writeClientSources(factoryRoot);
  if (state === "missing") return;
  const build = clientBuildDir(factoryRoot);
  await cp(CLIENT_DIR, build, { recursive: true });
  await writeBuildManifest(build, await hashClientSources(clientSourceDir(factoryRoot)));
  if (state === "stale") await writeClientSources(factoryRoot, "export const app = 2;\n");
}
