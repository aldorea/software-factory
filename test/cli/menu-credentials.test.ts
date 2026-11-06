import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { menuCredentials } from "../../src/cli/menu-credentials.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

describe("menuCredentials", () => {
  it("should report the failure and return false, and not throw, when the credentials folder cannot be created, as under a file in place of a folder, which stops root too", async () => {
    const root = await temp.make("menu-credentials-");
    const notAFolder = join(root, "notAFolder");
    await writeFile(notAFolder, "");
    const err: string[] = [];
    const credentials = menuCredentials({
      auth: {
        credentialsPath: join(notAFolder, "software-factory", "credentials"),
        environment: {},
        terminal: true,
        readSecret: async () => "sk-ant-oat01-abc",
        confirm: async () => true,
      },
      credentials: {},
      out: () => undefined,
      err: (text) => err.push(text),
    });

    expect(await credentials?.add("claude-code")).toBe(false);

    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^✗ factory: ENOTDIR/);
  });
});
