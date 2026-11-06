import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exec, ExecTimeoutError } from "../../src/workers/sh.ts";
import { isAlive } from "../process-alive.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
const leftovers: number[] = [];

afterEach(async () => {
  for (const pid of leftovers.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      continue;
    }
  }
  await temp.removeAll();
});

function grandchildScript(pidFile: string): string {
  return [
    `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });`,
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
    `setInterval(() => {}, 1000);`,
  ].join("\n");
}

async function pidIn(file: string): Promise<number> {
  for (let tries = 0; tries < 100; tries++) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (text !== "") {
      const pid = Number(text);
      leftovers.push(pid);
      return pid;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`no pid written to ${file}`);
}

async function until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (condition()) return true;
    await new Promise((done) => setTimeout(done, 50));
  }
  return condition();
}

describe("exec with a timeout", () => {
  it("should kill the whole process group at the timeout, so a grandchild that holds the output, as the remote helper of git does, does not outlive it", async () => {
    const dir = await temp.make("sh-timeout-");
    const pidFile = join(dir, "grandchild.pid");
    const started = Date.now();

    const outcome = await exec(process.execPath, ["-e", grandchildScript(pidFile)], { timeoutMs: 500 }).catch(
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(ExecTimeoutError);
    expect((outcome as ExecTimeoutError).killed).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    const grandchild = await pidIn(pidFile);
    expect(await until(() => !isAlive(grandchild), 2000)).toBe(true);
  });

  it("should return the exit code and the output of a command that ends before its timeout", async () => {
    const result = await exec(process.execPath, ["-e", `console.log("out"); console.error("err"); process.exit(3)`], {
      timeoutMs: 10_000,
    });

    expect(result).toEqual({ exitCode: 3, stdout: "out\n", stderr: "err\n" });
  });

  it("should kill the process group of a timed command when the factory is interrupted, as Ctrl-C did when the command shared the group of the terminal", async () => {
    const dir = await temp.make("sh-interrupt-");
    const pidFile = join(dir, "grandchild.pid");
    const script = join(dir, "factory.ts");
    await writeFile(
      script,
      [
        `import { exec } from ${JSON.stringify(resolve("src/workers/sh.ts"))};`,
        `await exec(process.execPath, ["-e", ${JSON.stringify(grandchildScript(pidFile))}], { timeoutMs: 60_000 });`,
      ].join("\n"),
    );
    const factory = spawn(process.execPath, [script], { stdio: "ignore" });
    const ended = new Promise<NodeJS.Signals | null>((done) => factory.on("exit", (_code, signal) => done(signal)));
    const grandchild = await pidIn(pidFile);

    factory.kill("SIGINT");

    expect(await ended).toBe("SIGINT");
    expect(await until(() => !isAlive(grandchild), 2000)).toBe(true);
  });
});
