import { chmod, mkdir, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { connect } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeRunLog } from "../../src/coordinator/run-log.ts";
import { startWebServer, type WebServer } from "../../src/web/server.ts";
import { cleanRun } from "../coordinator/run-log-fixtures.ts";
import { FakeClock } from "../fakes/clock.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
const servers: WebServer[] = [];
const errors: string[] = [];

afterEach(async () => {
  errors.splice(0);
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await temp.removeAll();
});

async function start(repoDir?: string): Promise<WebServer> {
  const server = await startWebServer({
    repoDir: repoDir ?? (await temp.make("web-server-")),
    port: 0,
    clock: new FakeClock("2026-10-24T08:00:00.000Z"),
    idleTimeoutMs: 600_000,
    err: (text) => errors.push(text),
  });
  servers.push(server);
  return server;
}

async function repoWithLog(): Promise<{ dir: string; runId: string }> {
  const dir = await temp.make("web-server-logs-");
  const log = { ...cleanRun(0), runId: "45-2026-10-24T08-00-00-000Z" };
  const runDir = join(dir, ".factory", "logs", log.runId);
  await writeRunLog(join(runDir, "run.json"), log);
  await writeFile(join(runDir, "S1-attempt-1.jsonl"), "<b>raw</b>\n");
  return { dir, runId: log.runId };
}

function refuses(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

function rawGet(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      received += chunk;
    });
    socket.once("close", () => resolve(received));
    socket.once("error", reject);
    socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
  });
}

describe("the web server", () => {
  it("should listen on 127.0.0.1 and no other interface, so nobody on the network sees the runs", async () => {
    const server = await start();
    const external = Object.values(networkInterfaces())
      .flat()
      .find((address) => address !== undefined && !address.internal && address.family === "IPv4");

    expect(server.host).toBe("127.0.0.1");
    expect(await refuses("127.0.0.1", server.port)).toBe(false);
    if (external !== undefined) expect(await refuses(external.address, server.port)).toBe(true);
  });

  it("should send a log as UTF-8 plain text that the browser must not sniff, because a log can contain HTML", async () => {
    const { dir, runId } = await repoWithLog();
    const server = await start(dir);

    const response = await fetch(`http://127.0.0.1:${server.port}/runs/${runId}/S1-attempt-1.jsonl`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("<b>raw</b>\n");
  });

  it("should not let a request reach a file outside the run folder with a path that climbs out of it", async () => {
    const { dir, runId } = await repoWithLog();
    await writeFile(join(dir, "secret.txt"), "the-secret");
    const server = await start(dir);

    const responses = await Promise.all(
      [`/runs/${runId}/../../../secret.txt`, `/runs/${runId}/%2e%2e/%2e%2e/%2e%2e/secret.txt`, `/runs/${runId}/..%2f..%2f..%2fsecret.txt`].map((path) =>
        rawGet(server.port, path),
      ),
    );

    for (const response of responses) {
      expect(response).toMatch(/^HTTP\/1\.1 404 /);
      expect(response).not.toContain("the-secret");
    }
  });

  it("should answer 500 and report the error to the terminal when a request fails for a reason that is not a missing file", async () => {
    const { dir, runId } = await repoWithLog();
    const locked = join(dir, ".factory", "logs", runId, "locked");
    await mkdir(locked);
    await writeFile(join(locked, "inside.log"), "x");
    await chmod(locked, 0o000);
    const server = await start(dir);

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/runs/${runId}/locked/inside.log`);

      expect(response.status).toBe(500);
      expect(await response.text()).toBe("internal error");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(`/runs/${runId}/locked/inside.log`);
      expect(errors[0]).toContain("EACCES");
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it("should stop answering after close, even to a client that keeps its connection open", async () => {
    const server = await start();
    const url = `http://127.0.0.1:${server.port}/`;
    expect((await fetch(url)).status).toBe(200);

    await server.close();

    expect(await refuses("127.0.0.1", server.port)).toBe(true);
  });
});
