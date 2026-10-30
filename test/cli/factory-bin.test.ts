import { spawn } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exec } from "../../src/workers/sh.ts";
import { tempDirs } from "../temp-dirs.ts";

const BIN = join(import.meta.dirname, "..", "..", "src", "cli", "factory.ts");

const temp = tempDirs();
afterEach(() => temp.removeAll());

describe("factory bin", () => {
  it("should start under plain node, which only strips types, and print the usage", async () => {
    const result = await exec(process.execPath, [BIN]);
    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    expect(result.stderr).toContain("usage: factory");
    expect(result.exitCode).not.toBe(0);
  });

  it("should print the output of init with no ANSI code when stdout is not a terminal", async () => {
    const dir = await temp.make("bin-init-");
    await exec("git", ["init", "-q", "-b", "main", dir]);
    await exec("git", ["-C", dir, "remote", "add", "origin", "https://example.invalid/toy.git"]);

    const result = await exec(process.execPath, [BIN, "init", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓ wrote .factory/config.ts");
    expect(result.stdout).not.toContain(String.fromCharCode(27));
  });

  it("should stop factory web on Ctrl-C with exit code 0", async () => {
    const dir = await temp.make("bin-web-");
    const child = spawn(process.execPath, [BIN, "web", dir, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
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
