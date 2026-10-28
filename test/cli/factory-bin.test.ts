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

  it("should stop factory web on Ctrl-C with exit code 0", async () => {
    const dir = await temp.make("bin-web-");
    const child = spawn(process.execPath, [BIN, "web", dir, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    const url = await new Promise<string>((resolve, reject) => {
      let text = "";
      child.stdout.on("data", (chunk: Buffer) => {
        text += chunk.toString();
        const found = /http:\/\/\S+/.exec(text)?.[0];
        if (found !== undefined) resolve(found);
      });
      child.once("exit", () => reject(new Error(`factory web exited before it printed a URL: ${text}`)));
    }).catch((error: Error) => {
      child.kill("SIGKILL");
      throw error;
    });

    expect((await fetch(url)).status).toBe(200);
    child.kill("SIGINT");

    expect(await exited).toBe(0);
  });
});
