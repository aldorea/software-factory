import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProtectedPaths } from "../../src/cli/protected-paths.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

async function repoWithConfig(source: string | null): Promise<string> {
  const dir = await temp.make("protected-paths-");
  if (source !== null) {
    await mkdir(join(dir, ".factory"));
    await writeFile(join(dir, ".factory", "config.ts"), source);
  }
  return dir;
}

describe("readProtectedPaths", () => {
  it("should read the protected paths of the target repo's config", async () => {
    const dir = await repoWithConfig('export default { protectedPaths: ["package.json", "prisma/schema.prisma"] };\n');

    expect(await readProtectedPaths(dir)).toEqual(["package.json", "prisma/schema.prisma"]);
  });

  it("should fail closed when the config is missing, because validation would then let any subtask touch protected paths", async () => {
    const dir = await repoWithConfig(null);

    await expect(readProtectedPaths(dir)).rejects.toThrow(`${join(dir, ".factory", "config.ts")} does not exist`);
  });

  it("should fail closed when the config gives no list of protected paths", async () => {
    const dir = await repoWithConfig("export default { protectedPaths: \"package.json\" };\n");

    await expect(readProtectedPaths(dir)).rejects.toThrow("protectedPaths must be a list of strings");
  });
});
