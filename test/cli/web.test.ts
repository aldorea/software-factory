import { mkdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, type CliEnv } from "../../src/cli/main.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeGitHub } from "../fakes/github.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeVerifier } from "../fakes/verifier.ts";
import { FakeWorkerRunner } from "../fakes/worker-runner.ts";
import { cleanRun, failedRun } from "../coordinator/run-log-fixtures.ts";
import { writeRunningRun } from "../coordinator/running-run.ts";
import { repoWithRuns, temp } from "../web/web-helpers.ts";

const stops: AbortController[] = [];
const blockers: Server[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) stop.abort();
  await Promise.all(blockers.splice(0).map((blocker) => new Promise((resolve) => blocker.close(resolve))));
  await temp.removeAll();
});

function cli(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const stop = new AbortController();
  stops.push(stop);
  let announce: (line: string) => void = () => {};
  const firstLine = new Promise<string>((resolve) => {
    announce = resolve;
  });
  const env: CliEnv = {
    cwd,
    factoryRoot: "/factory",
    clock: new FakeClock("2026-10-24T08:00:00.000Z"),
    github: () => new FakeGitHub([]),
    runner: () => new FakeWorkerRunner(),
    verifier: () => new FakeVerifier(),
    notifier: new FakeNotifier(),
    credentials: {},
    docker: async () => null,
    gh: async () => null,
    launch: async () => 0,
    signal: stop.signal,
    out: (text) => {
      out.push(text);
      announce(text);
    },
    err: (text) => err.push(text),
  };
  return { env, out, err, stop, firstLine };
}

function urlOf(line: string): string {
  return /http:\/\/\S+/.exec(line)?.[0] ?? "";
}

describe("factory web", () => {
  it("should listen on 127.0.0.1, print the URL, serve the run list and stop on the abort signal leaving no server open", async () => {
    const dir = await repoWithRuns([{ log: cleanRun(0) }, { log: failedRun(1) }]);
    const { env, err, stop, firstLine } = cli(dir);
    const exit = main(["web", "--port", "0"], env);

    const url = urlOf(await firstLine);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("1-run-01");

    stop.abort();
    expect(await exit).toBe(0);
    await expect(fetch(url)).rejects.toThrow();
    expect(err).toEqual([]);
  });

  it("should show a run whose process died as abandoned using the default attemptIdleTimeoutMs, and as running when the config allows a longer silence", async () => {
    const silent = new Date(Date.parse("2026-10-24T08:00:00.000Z") - 30 * 60_000);
    const abandonedDir = await temp.make("web-cli-abandoned-");
    await writeRunningRun({ logsDir: join(abandonedDir, ".factory", "logs"), runJsonAt: silent, logAt: silent });
    const patientDir = await temp.make("web-cli-patient-");
    await writeRunningRun({ logsDir: join(patientDir, ".factory", "logs"), runJsonAt: silent, logAt: silent });
    await mkdir(join(patientDir, ".factory"), { recursive: true });
    await writeFile(
      join(patientDir, ".factory", "config.ts"),
      'export default { image: "worker:dev", checks: [{ name: "spec", command: "true" }], environment: () => ({}), protectedPaths: [], limits: { attemptIdleTimeoutMs: 3_600_000 } };\n',
    );
    const pages: string[] = [];

    for (const dir of [abandonedDir, patientDir]) {
      const { env, firstLine, stop } = cli(dir);
      const exit = main(["web", "--port", "0"], env);
      pages.push(await (await fetch(urlOf(await firstLine))).text());
      stop.abort();
      expect(await exit).toBe(0);
    }

    expect(pages[0]).toContain(">abandoned<");
    expect(pages[1]).toContain(">running<");
  });

  it("should take the target repo from the argument", async () => {
    const dir = await repoWithRuns([{ log: cleanRun(0) }]);
    const { env, firstLine } = cli(await temp.make("web-cli-elsewhere-"));
    const exit = main(["web", dir, "--port", "0"], env);

    const response = await fetch(urlOf(await firstLine));
    expect(await response.text()).toContain("1-run-00");
    stops[0]?.abort();
    expect(await exit).toBe(0);
  });

  it("should serve on the port of --port", async () => {
    const dir = await temp.make("web-cli-port-");
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const free = (probe.address() as { port: number }).port;
    await new Promise((resolve) => probe.close(resolve));
    const { env, stop, firstLine } = cli(dir);
    const exit = main(["web", "--port", String(free)], env);

    expect(urlOf(await firstLine)).toBe(`http://127.0.0.1:${free}/`);
    stop.abort();
    expect(await exit).toBe(0);
  });

  it("should end with a clear message and exit code 1 when the port is taken", async () => {
    const blocker = createServer();
    blockers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const taken = (blocker.address() as { port: number }).port;
    const { env, err, out } = cli(await temp.make("web-cli-busy-"));

    expect(await main(["web", "--port", String(taken)], env)).toBe(1);
    expect(err.join("\n")).toContain(`port ${taken} is already in use`);
    expect(out).toEqual([]);
  });

  it.each([["--port", "abc"], ["--port", "70000"], ["--port", "-1"], ["a", "b"]])(
    "should print the usage when the arguments are %j",
    async (...args) => {
      const { env, err } = cli(await temp.make("web-cli-usage-"));

      expect(await main(["web", ...args], env)).toBe(2);
      expect(err.join("\n")).toContain("factory web [target-repo] [--port <port>]");
    },
  );

  it("should list factory web in the usage of factory", async () => {
    const { env, err } = cli(await temp.make("web-cli-help-"));

    expect(await main([], env)).toBe(2);
    expect(err.join("\n")).toContain("factory web [target-repo] [--port <port>]");
  });

  it("should serve an empty home page for a repo that has no run log", async () => {
    const { env, stop, firstLine } = cli(await temp.make("web-cli-none-"));
    const exit = main(["web", "--port", "0"], env);

    const response = await fetch(urlOf(await firstLine));
    expect(response.status).toBe(200);
    stop.abort();
    expect(await exit).toBe(0);
  });

  it("should refuse a request whose Host header is not the loopback address of the port", async () => {
    const { env, stop, firstLine } = cli(await temp.make("web-cli-host-"));
    const exit = main(["web", "--port", "0"], env);
    const url = new URL(urlOf(await firstLine));

    const status = await new Promise<number | undefined>((resolve, reject) => {
      const outgoing = request(
        { host: url.hostname, port: url.port, path: "/", headers: { Host: "evil.example" }, agent: false },
        (incoming) => {
          incoming.resume();
          resolve(incoming.statusCode);
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
    expect(status).toBe(403);
    stop.abort();
    expect(await exit).toBe(0);
  });
});
