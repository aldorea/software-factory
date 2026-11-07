import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { launchWebAction, stopWebAction, type WebActionStart } from "../../src/web/launcher.ts";
import { readWebAction } from "../../src/web/web-action-files.ts";
import type { WebActionRecord } from "../../src/web/web-action.ts";
import { isAlive } from "../process-alive.ts";
import { tempDirs } from "../temp-dirs.ts";

const FACTORY_BIN = join(import.meta.dirname, "..", "..", "src", "cli", "factory.ts");
const LAUNCHER = pathToFileURL(join(import.meta.dirname, "..", "..", "src", "web", "launcher.ts")).href;

const temp = tempDirs();
const groups: number[] = [];

afterEach(async () => {
  for (const group of groups.splice(0)) {
    for (const target of [-group, group]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {}
    }
  }
  await temp.removeAll();
});

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function launchFromAServer(
  repoDir: string,
  args: string[],
  options: { start?: Partial<WebActionStart>; env?: Record<string, string> } = {},
): Promise<{ record: WebActionRecord; server: number }> {
  const script = [
    `import { launchWebAction } from ${JSON.stringify(LAUNCHER)};`,
    `const input = ${JSON.stringify({
      repoDir,
      factoryBin: FACTORY_BIN,
      start: { id: "2026-11-07T10-42-00-000Z-doctor", command: "doctor", args, issue: null, ...options.start },
    })};`,
    "const record = await launchWebAction({ ...input, now: new Date() });",
    "process.stdout.write(JSON.stringify(record) + '\\n');",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const server = spawn(process.execPath, ["--input-type=module", "-e", script], {
    detached: true,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (server.pid === undefined) throw new Error("the server did not start");
  groups.push(server.pid);
  const line = await new Promise<string>((resolve, reject) => {
    let text = "";
    server.stdout.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes("\n")) resolve(text.split("\n")[0] ?? "");
    });
    server.once("exit", () => reject(new Error(`the server exited before it launched: ${text}`)));
  });
  const record = JSON.parse(line) as WebActionRecord;
  groups.push(record.pid);
  return { record, server: server.pid };
}

describe("the launcher of web actions", () => {
  it("should keep a web action alive after Ctrl-C stops the server that started it, because it runs in a process group of its own", async () => {
    const repoDir = await temp.make("launcher-outlives-");
    const { record, server } = await launchFromAServer(repoDir, ["web", "--port", "0"]);
    const output = join(repoDir, ".factory", "web", record.id, "output.log");
    await until(async () => (await readFile(output, "utf8")).includes("http://127.0.0.1:"), "the action to listen");

    const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(await readFile(output, "utf8"))?.[0] ?? "";

    process.kill(-server, "SIGINT");
    await until(() => !isAlive(server), "the server to stop");
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(isAlive(record.pid)).toBe(true);
    expect((await fetch(url)).status).toBe(200);
    expect(record.processStart).not.toBeNull();
  });

  it("should end a web action as Ctrl-C does when it is stopped, and the CLI records its end", async () => {
    const repoDir = await temp.make("launcher-stop-");
    const record = await launchWebAction({
      repoDir,
      factoryBin: FACTORY_BIN,
      start: { id: "2026-11-07T10-42-00-000Z-doctor", command: "doctor", args: ["web", "--port", "0"], issue: null },
      now: new Date("2026-11-07T10:42:00.000Z"),
    });
    groups.push(record.pid);
    const output = join(repoDir, ".factory", "web", record.id, "output.log");
    await until(async () => (await readFile(output, "utf8")).includes("http://127.0.0.1:"), "the action to listen");

    expect(await stopWebAction(record)).toBe(true);
    await until(() => !isAlive(record.pid), "the action to stop");

    const read = await readWebAction(repoDir, record.id);
    expect(read?.end?.exitCode).toBe(0);
    expect(read?.record).toEqual(record);
  });

  it("should not signal a process whose start time differs from action.json, because the system reused its number", async () => {
    expect(await stopWebAction({ pid: process.pid, processStart: "Thu Jan  1 00:00:00 1970" })).toBe(false);
  });

  it("should pass each argument to the CLI as it is, with no shell to interpret it", async () => {
    const repoDir = await temp.make("launcher-no-shell-");
    const record = await launchWebAction({
      repoDir,
      factoryBin: FACTORY_BIN,
      start: { id: "2026-11-07T10-42-00-000Z-validate-28", command: "validate", args: ["validate", "28;touch pwned"], issue: 28 },
      now: new Date("2026-11-07T10:42:00.000Z"),
    });
    groups.push(record.pid);

    await until(async () => (await readWebAction(repoDir, record.id))?.end !== null, "the action to end");

    expect((await readWebAction(repoDir, record.id))?.end?.exitCode).toBe(2);
    expect(existsSync(join(repoDir, "pwned"))).toBe(false);
  });

  it("should pass the standard input of the web action to the CLI and write it nowhere under .factory/web/, so a credential reaches factory auth alone", async () => {
    const repoDir = await temp.make("launcher-stdin-");
    const config = await temp.make("launcher-stdin-xdg-");
    const secret = "sk-ant-oat01-launcher-secret-a1f3";
    const { record } = await launchFromAServer(repoDir, ["auth", "claude-code"], {
      start: { id: "2026-11-07T10-42-00-000Z-auth", command: "auth", stdin: `${secret}\n` },
      env: { XDG_CONFIG_HOME: config, CLAUDE_CODE_OAUTH_TOKEN: "" },
    });

    await until(async () => (await readWebAction(repoDir, record.id))?.end != null, "the action to end");

    expect((await readWebAction(repoDir, record.id))?.end?.exitCode).toBe(0);
    expect(await readFile(join(config, "software-factory", "credentials"), "utf8")).toBe(`CLAUDE_CODE_OAUTH_TOKEN=${secret}\n`);
    expect(record.args).toEqual(["auth", "claude-code"]);
    const dir = join(repoDir, ".factory", "web", record.id);
    for (const name of await readdir(dir)) {
      expect(await readFile(join(dir, name), "utf8")).not.toContain("launcher-secret");
    }
  });
});
