import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exec } from "../../src/workers/sh.ts";
import type { ExecResult } from "../../src/workers/types.ts";
import { tempDirs } from "../temp-dirs.ts";

const BIN = join(import.meta.dirname, "..", "..", "src", "cli", "factory.ts");

const temp = tempDirs();
afterEach(() => temp.removeAll());

async function factory(args: string[], options: { config?: string; stdin?: string } = {}): Promise<ExecResult> {
  const config = options.config ?? (await temp.make("bin-xdg-"));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, XDG_CONFIG_HOME: config, CLAUDE_CODE_OAUTH_TOKEN: "", OPENCODE_API_KEY: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
    child.stdin.end(options.stdin ?? "");
  });
}

describe("factory bin", () => {
  it("should start under plain node, which only strips types, and print the usage", async () => {
    const result = await factory([]);
    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    expect(result.stderr).toContain("usage: factory");
    expect(result.exitCode).not.toBe(0);
  });

  it("should print the output of init with no ANSI code when stdout is not a terminal", async () => {
    const dir = await temp.make("bin-init-");
    await exec("git", ["init", "-q", "-b", "main", dir]);
    await exec("git", ["-C", dir, "remote", "add", "origin", "https://example.invalid/toy.git"]);

    const result = await factory(["init", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓ wrote .factory/config.ts");
    expect(result.stdout).not.toContain(String.fromCharCode(27));
  });

  it("should end the output of init with the Next: list and mark the credential step when the credential is saved in the XDG folder", async () => {
    const config = await temp.make("bin-xdg-");
    const dir = await temp.make("bin-init-");
    await exec("git", ["init", "-q", "-b", "main", dir]);
    await exec("git", ["-C", dir, "remote", "add", "origin", "https://example.invalid/toy.git"]);
    await factory(["auth", "claude-code"], { config, stdin: "sk-ant-oat01-saved\n" });

    const result = await factory(["init", dir], { config });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Next:");
    expect(result.stdout).toContain("✓ 2. factory auth");
    expect(result.stdout).toContain("  1. fill .factory/.env");
  });

  it("should leave the credential step of init undone, and still succeed, when the credentials file has a line it does not understand", async () => {
    const config = await temp.make("bin-xdg-");
    const file = join(config, "software-factory", "credentials");
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, "broken\n", { mode: 0o600 });
    const dir = await temp.make("bin-init-");
    await exec("git", ["init", "-q", "-b", "main", dir]);
    await exec("git", ["-C", dir, "remote", "add", "origin", "https://example.invalid/toy.git"]);

    const result = await factory(["init", dir], { config });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("  2. factory auth");
    expect(result.stdout).toContain(`⚠ ${file} line 1 is not understood`);
    expect(result.stderr).toBe("");
  });

  it("should warn in init with the chmod fix, and still succeed, when the credentials file can be read by others", async () => {
    const config = await temp.make("bin-xdg-");
    const file = join(config, "software-factory", "credentials");
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, "OPENCODE_API_KEY=saved\n");
    await chmod(file, 0o644);
    const dir = await temp.make("bin-init-");
    await exec("git", ["init", "-q", "-b", "main", dir]);
    await exec("git", ["-C", dir, "remote", "add", "origin", "https://example.invalid/toy.git"]);

    const result = await factory(["init", dir], { config });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`⚠ ${file} can be read by other users (mode 644) → chmod 600 ${file}`);
    expect(result.stdout).toContain("Next:");
    expect(result.stderr).toBe("");
  });

  it("should save the credential piped to factory auth in the XDG folder, with mode 0600, and never print it", async () => {
    const config = await temp.make("bin-xdg-");

    const result = await factory(["auth", "claude-code"], { config, stdin: "sk-ant-oat01-piped\n" });

    const file = join(config, "software-factory", "credentials");
    expect(result.exitCode).toBe(0);
    expect(await readFile(file, "utf8")).toBe("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-piped\n");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(config, "software-factory"))).mode & 0o777).toBe(0o700);
    expect(result.stdout + result.stderr).not.toContain("sk-ant-oat01-piped");
    expect(result.stdout).not.toContain(String.fromCharCode(27));
  });

  it("should fail factory auth with the list of agents when the agent is unknown", async () => {
    const config = await temp.make("bin-xdg-");

    const result = await factory(["auth", "gemini"], { config, stdin: "x\n" });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("use one of claude-code, opencode");
  });

  it("should stop factory run with the chmod fix before Docker when the credentials file can be read by others", async () => {
    const config = await temp.make("bin-xdg-");
    const file = join(config, "software-factory", "credentials");
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, "OPENCODE_API_KEY=saved\n");
    await chmod(file, 0o644);

    const result = await factory(["run", "42", config], { config });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`chmod 600 ${file}`);
    expect((await stat(file)).mode & 0o777).toBe(0o644);
  });

  it("should stop factory run with the line number when the credentials file has a line it does not understand", async () => {
    const config = await temp.make("bin-xdg-");
    const file = join(config, "software-factory", "credentials");
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, "OPENCODE_API_KEY=saved\nbroken\n", { mode: 0o600 });

    const result = await factory(["run", "42", config], { config });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("line 2");
  });

  it("should list the chmod fix as a failed check of factory doctor, and not stop, when the credentials file can be read by others", async () => {
    const config = await temp.make("bin-xdg-");
    const file = join(config, "software-factory", "credentials");
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, "OPENCODE_API_KEY=saved\n");
    await chmod(file, 0o644);

    const result = await factory(["doctor", config], { config });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Docker");
    expect(result.stdout).toContain(`✗ ${file} can be read by other users (mode 644) → chmod 600 ${file}`);
    expect(result.stderr).toBe("");
  });

  it("should stop factory web on Ctrl-C with exit code 0", async () => {
    const dir = await temp.make("bin-web-");
    const config = await temp.make("bin-xdg-");
    const child = spawn(process.execPath, [BIN, "web", dir, "--port", "0"], {
      env: { ...process.env, XDG_CONFIG_HOME: config },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let text = "";
        child.stdout.on("data", (chunk: Buffer) => {
          text += chunk.toString();
          const found = /http:\/\/\S+/.exec(text)?.[0];
          if (found !== undefined) resolve(found);
        });
        child.once("exit", () => reject(new Error(`factory web exited before it printed a URL: ${text}`)));
      });

      expect((await fetch(url)).status).toBe(200);
      child.kill("SIGINT");

      expect(await exited).toBe(0);
    } finally {
      child.kill("SIGKILL");
    }
  });
});
