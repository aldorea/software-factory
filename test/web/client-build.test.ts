import { readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BUILD_MANIFEST, clientBuildDir, clientBuildProblem, clientSourceDir, hashClientSources } from "../../src/web/client-build.ts";
import { writeClientBuild, writeClientSources } from "./client-build-fixtures.ts";
import { temp } from "./web-helpers.ts";

afterEach(() => temp.removeAll());

describe("the readiness of the build of the web client", () => {
  it("should pass when the hash of the build is the hash of the current sources", async () => {
    const root = await temp.make("client-build-");
    await writeClientBuild(root);

    expect(await clientBuildProblem(root)).toBeNull();
  });

  it("should fail when there is no build", async () => {
    const root = await temp.make("client-build-");
    await writeClientBuild(root, "missing");

    expect(await clientBuildProblem(root)).toBe(
      `the web client is not built: ${join(clientBuildDir(root), BUILD_MANIFEST)} is missing or unreadable`,
    );
  });

  it("should fail when the manifest of the build cannot be read", async () => {
    const root = await temp.make("client-build-");
    await writeClientBuild(root);
    await writeFile(join(clientBuildDir(root), BUILD_MANIFEST), "{not json");

    expect(await clientBuildProblem(root)).toContain("the web client is not built");
  });

  it("should fail when the sources changed after the build", async () => {
    const root = await temp.make("client-build-");
    await writeClientBuild(root, "stale");

    expect(await clientBuildProblem(root)).toBe("the build of the web client comes from older sources than the current ones");
  });

  it("should fail when a source file was removed after the build", async () => {
    const root = await temp.make("client-build-");
    await writeClientBuild(root);
    await rm(join(clientSourceDir(root), "index.html"));

    expect(await clientBuildProblem(root)).not.toBeNull();
  });

  it("should pass when a git checkout rewrites the sources with the same content, because the hash comes from the content and not the times", async () => {
    const root = await temp.make("client-build-");
    await writeClientBuild(root);
    const main = join(clientSourceDir(root), "app", "main.tsx");
    await writeFile(main, await readFile(main));
    const later = new Date(Date.now() + 3_600_000);
    await utimes(main, later, later);

    expect(await clientBuildProblem(root)).toBeNull();
  });

  it("should not count a hidden file such as .DS_Store as a source, so the Finder does not make the build stale", async () => {
    const root = await temp.make("client-build-");
    await writeClientBuild(root);
    await writeFile(join(clientSourceDir(root), "app", ".DS_Store"), "finder");

    expect(await clientBuildProblem(root)).toBeNull();
  });

  it("should give another hash when a file moves to another path with the same content", async () => {
    const root = await temp.make("client-build-");
    await writeClientSources(root);
    const before = await hashClientSources(clientSourceDir(root));
    await writeFile(join(clientSourceDir(root), "app", "other.tsx"), await readFile(join(clientSourceDir(root), "app", "main.tsx")));
    await rm(join(clientSourceDir(root), "app", "main.tsx"));

    expect(await hashClientSources(clientSourceDir(root))).not.toBe(before);
  });
});

const CLIENT_APP = fileURLToPath(new URL("../../src/web/client/app", import.meta.url));
const CLIENT = resolve(CLIENT_APP, "..");
const IMPORT = /^\s*(import|export)\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gm;

async function clientFiles(): Promise<string[]> {
  const entries = await readdir(CLIENT_APP, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name)).map((entry) => join(entry.parentPath, entry.name));
}

describe("the sources of the web client", () => {
  it("should import only types from outside the folder of the client, because the hash of the build covers only that folder", async () => {
    const outside: string[] = [];
    for (const file of await clientFiles()) {
      for (const [, , typeOnly, specifier] of (await readFile(file, "utf8")).matchAll(IMPORT)) {
        if (specifier === undefined || !specifier.startsWith(".")) continue;
        const target = relative(CLIENT, resolve(file, "..", specifier));
        if (target.startsWith("..") && typeOnly === undefined) outside.push(`${relative(CLIENT, file)} → ${specifier}`);
      }
    }

    expect(outside).toEqual([]);
  });
});
