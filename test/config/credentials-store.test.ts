import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deleteCredential, loadCredentials, readSavedCredentials, saveCredential } from "../../src/config/credentials-store.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

async function credentialsPath(): Promise<string> {
  return join(await temp.make("credentials-"), "software-factory", "credentials");
}

async function seed(path: string, text: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, text, { mode });
  await chmod(path, mode);
}

describe("saveCredential", () => {
  it("should create the folder with mode 0700 and the file with mode 0600", async () => {
    const path = await credentialsPath();

    await saveCredential(path, "claude-code", "sk-ant-oat-abc");

    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toBe("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-abc\n");
  });

  it("should change only the line of the agent and keep the other lines as they were", async () => {
    const path = await credentialsPath();
    await seed(path, "OPENCODE_API_KEY=keep\nCLAUDE_CODE_OAUTH_TOKEN=old\n");

    await saveCredential(path, "claude-code", "new");

    expect(await readFile(path, "utf8")).toBe("OPENCODE_API_KEY=keep\nCLAUDE_CODE_OAUTH_TOKEN=new\n");
  });

  it("should add a line for a second agent without touching the first", async () => {
    const path = await credentialsPath();
    await saveCredential(path, "claude-code", "one");

    await saveCredential(path, "opencode", "two");

    expect(await readFile(path, "utf8")).toBe("CLAUDE_CODE_OAUTH_TOKEN=one\nOPENCODE_API_KEY=two\n");
  });

  it("should write through a temporary file that it renames, so no temporary file is left and the mode stays 0600", async () => {
    const path = await credentialsPath();
    await seed(path, "OPENCODE_API_KEY=a\n");

    await saveCredential(path, "opencode", "b");

    expect(await readdir(dirname(path))).toEqual(["credentials"]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("should refuse to write over a file that others can read, and leave it unchanged", async () => {
    const path = await credentialsPath();
    await seed(path, "OPENCODE_API_KEY=a\n", 0o644);

    const outcome = await saveCredential(path, "opencode", "b");

    expect(outcome.ok).toBe(false);
    expect(await readFile(path, "utf8")).toBe("OPENCODE_API_KEY=a\n");
    expect((await stat(path)).mode & 0o777).toBe(0o644);
  });

  it("should refuse to write over a file with a line it does not understand", async () => {
    const path = await credentialsPath();
    await seed(path, "nonsense\n");

    expect((await saveCredential(path, "opencode", "b")).ok).toBe(false);
    expect(await readFile(path, "utf8")).toBe("nonsense\n");
  });
});

describe("deleteCredential", () => {
  it("should remove only the line of the agent and keep the other lines as they were", async () => {
    const path = await credentialsPath();
    await seed(path, "CLAUDE_CODE_OAUTH_TOKEN=one\nOPENCODE_API_KEY=two\n");

    expect(await deleteCredential(path, "claude-code")).toEqual({ ok: true, path });

    expect(await readFile(path, "utf8")).toBe("OPENCODE_API_KEY=two\n");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dirname(path))).toEqual(["credentials"]);
  });

  it("should leave an empty file that reads as no credential when the last line goes", async () => {
    const path = await credentialsPath();
    await seed(path, "OPENCODE_API_KEY=two\n");

    await deleteCredential(path, "opencode");

    expect(await readFile(path, "utf8")).toBe("");
    expect(await readSavedCredentials(path)).toEqual({ ok: true, values: {} });
  });

  it("should succeed and create nothing when there is no file", async () => {
    const path = await credentialsPath();

    expect((await deleteCredential(path, "opencode")).ok).toBe(true);

    await expect(stat(dirname(path))).rejects.toThrow();
  });

  it("should refuse to rewrite a file that others can read, and leave it unchanged", async () => {
    const path = await credentialsPath();
    await seed(path, "OPENCODE_API_KEY=a\n", 0o644);

    const outcome = await deleteCredential(path, "opencode");

    expect(outcome.ok).toBe(false);
    expect(await readFile(path, "utf8")).toBe("OPENCODE_API_KEY=a\n");
  });

  it("should refuse to rewrite a file with a line it does not understand, and leave it unchanged", async () => {
    const path = await credentialsPath();
    await seed(path, "OPENCODE_API_KEY=a\nnonsense\n");

    expect((await deleteCredential(path, "opencode")).ok).toBe(false);
    expect(await readFile(path, "utf8")).toBe("OPENCODE_API_KEY=a\nnonsense\n");
  });
});

describe("readSavedCredentials", () => {
  it("should read nothing from a file that does not exist", async () => {
    expect(await readSavedCredentials(await credentialsPath())).toEqual({ ok: true, values: {} });
  });

  it.each([0o644, 0o640, 0o604, 0o660])("should fail closed with the chmod 600 fix when the mode is %o", async (mode) => {
    const path = await credentialsPath();
    await seed(path, "OPENCODE_API_KEY=a\n", mode);

    const result = await readSavedCredentials(path);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain(`chmod 600 ${path}`);
    expect((await stat(path)).mode & 0o777).toBe(mode);
  });

  it("should fail closed on a line it does not understand", async () => {
    const path = await credentialsPath();
    await seed(path, "OPENCODE_API_KEY=a\nbroken line\n");

    const result = await readSavedCredentials(path);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain("line 2");
  });
});

describe("loadCredentials", () => {
  it("should let the environment variable win and take the other agents from the file", async () => {
    const path = await credentialsPath();
    await seed(path, "OPENCODE_API_KEY=saved-key\nCLAUDE_CODE_OAUTH_TOKEN=saved-token\n");

    const loaded = await loadCredentials(path, { OPENCODE_API_KEY: "env-key" });

    expect(loaded).toEqual({
      ok: true,
      credentials: { opencode: "env-key", "claude-code": "saved-token" },
      saved: { opencode: "saved-key", "claude-code": "saved-token" },
    });
  });

  it("should stop on an open file even when the environment holds every credential", async () => {
    const path = await credentialsPath();
    await seed(path, "OPENCODE_API_KEY=saved\n", 0o644);

    const loaded = await loadCredentials(path, { OPENCODE_API_KEY: "e", CLAUDE_CODE_OAUTH_TOKEN: "e" });

    expect(loaded.ok).toBe(false);
  });
});
