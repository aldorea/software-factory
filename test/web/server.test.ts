import { networkInterfaces } from "node:os";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startWebServer, type WebServer } from "../../src/web/server.ts";
import { FakeClock } from "../fakes/clock.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
const servers: WebServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await temp.removeAll();
});

async function start(): Promise<WebServer> {
  const server = await startWebServer({ repoDir: await temp.make("web-server-"), port: 0, clock: new FakeClock("2026-10-24T08:00:00.000Z") });
  servers.push(server);
  return server;
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

  it("should stop answering after close, even to a client that keeps its connection open", async () => {
    const server = await start();
    const url = `http://127.0.0.1:${server.port}/`;
    expect((await fetch(url)).status).toBe(200);

    await server.close();

    expect(await refuses("127.0.0.1", server.port)).toBe(true);
  });
});
