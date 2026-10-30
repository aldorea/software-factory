import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { menuCredentials } from "../../src/cli/menu-credentials.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

describe("menuCredentials", () => {
  it("should report the failure and return false, and not throw, when the credentials folder cannot be written", async () => {
    const root = await temp.make("menu-credentials-");
    const locked = join(root, "locked");
    await mkdir(locked, { mode: 0o500 });
    await chmod(locked, 0o500);
    const err: string[] = [];
    const credentials = menuCredentials({
      auth: {
        credentialsPath: join(locked, "software-factory", "credentials"),
        environment: {},
        terminal: true,
        readSecret: async () => "sk-ant-oat01-abc",
        confirm: async () => true,
      },
      credentials: {},
      out: () => undefined,
      err: (text) => err.push(text),
    });

    try {
      expect(await credentials?.add("claude-code")).toBe(false);
    } finally {
      await chmod(locked, 0o700);
    }

    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^✗ factory: EACCES/);
  });
});
