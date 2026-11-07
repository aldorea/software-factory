import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, type CliEnv } from "../../src/cli/main.ts";
import type { RunsResponse } from "../../src/web/api.ts";
import type { WebActionView } from "../../src/web/web-action-view.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeGitHub } from "../fakes/github.ts";
import { FakeImageDocker } from "../fakes/image-docker.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeVerifier } from "../fakes/verifier.ts";
import { FakeWorkerRunner } from "../fakes/worker-runner.ts";
import { cleanRun, failedRun } from "../coordinator/run-log-fixtures.ts";
import { writeRunningRun } from "../coordinator/running-run.ts";
import { writeClientBuild, type BuildState } from "../web/client-build-fixtures.ts";
import { repoWithRuns, temp } from "../web/web-helpers.ts";

const stops: AbortController[] = [];
const blockers: Server[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) stop.abort();
  await Promise.all(blockers.splice(0).map((blocker) => new Promise((resolve) => blocker.close(resolve))));
  await temp.removeAll();
});

async function factoryRoot(state: BuildState = "built"): Promise<string> {
  const root = await temp.make("web-cli-factory-");
  await writeClientBuild(root, state);
  return root;
}

async function cli(cwd: string, build: BuildState = "built") {
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
    factoryRoot: await factoryRoot(build),
    clock: new FakeClock("2026-10-24T08:00:00.000Z"),
    github: () => new FakeGitHub([]),
    runner: () => new FakeWorkerRunner(),
    verifier: () => new FakeVerifier(),
    notifier: new FakeNotifier(),
    credentials: {},
    docker: async () => null,
    gh: async () => null,
    claudeSession: async () => null,
    originHead: async () => null,
    push: async () => null,
    launch: async () => 0,
    images: new FakeImageDocker(),
    signal: stop.signal,
    out: (text) => {
      out.push(text);
      announce(text);
    },
    err: (text) => err.push(text),
  };
  return { env, out, err, stop, firstLine };
}

async function runIds(url: string): Promise<string[]> {
  const response = await fetch(new URL("/api/runs", url));
  expect(response.status).toBe(200);
  return ((await response.json()) as RunsResponse).runs.map((row) => `${row.runId} ${row.status}`);
}

function urlOf(line: string): string {
  return /http:\/\/\S+/.exec(line)?.[0] ?? "";
}

describe("factory web", () => {
  it("should listen on 127.0.0.1, print the URL, serve the client and the run list and stop on the abort signal leaving no server open", async () => {
    const dir = await repoWithRuns([{ log: cleanRun(0) }, { log: failedRun(1) }]);
    const { env, err, stop, firstLine } = await cli(dir);
    const exit = main(["web", "--port", "0"], env);

    const url = urlOf(await firstLine);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{64}$/);
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="root"></div>');
    expect(await runIds(url)).toEqual(["1-run-01 ready", "1-run-00 ready"]);

    stop.abort();
    expect(await exit).toBe(0);
    await expect(fetch(url)).rejects.toThrow();
    expect(err).toEqual([]);
  });

  it("should show a run whose process died as abandoned using the default attemptIdleTimeoutMs for a run log without it, and as running when the run log recorded a longer silence", async () => {
    const silent = new Date(Date.parse("2026-10-24T08:00:00.000Z") - 30 * 60_000);
    const abandonedDir = await temp.make("web-cli-abandoned-");
    await writeRunningRun({ logsDir: join(abandonedDir, ".factory", "logs"), runJsonAt: silent, logAt: silent });
    const patientDir = await temp.make("web-cli-patient-");
    await writeRunningRun({
      logsDir: join(patientDir, ".factory", "logs"),
      runJsonAt: silent,
      logAt: silent,
      attemptIdleTimeoutMs: 3_600_000,
    });
    const lists: string[][] = [];

    for (const dir of [abandonedDir, patientDir]) {
      const { env, firstLine, stop } = await cli(dir);
      const exit = main(["web", "--port", "0"], env);
      lists.push(await runIds(urlOf(await firstLine)));
      stop.abort();
      expect(await exit).toBe(0);
    }

    expect(lists[0]?.[0]).toMatch(/ abandoned$/);
    expect(lists[1]?.[0]).toMatch(/ running$/);
  });

  it.each([
    ["is broken", "export default { this is not valid"],
    ["is invalid", "export default {};\n"],
    ["does not exist", null],
  ])("should start and serve the run list when the .factory/config.ts of the repo %s, because it only reads .factory/logs", async (_case, config) => {
    const dir = await repoWithRuns([{ log: cleanRun(0) }]);
    if (config !== null) {
      await mkdir(join(dir, ".factory"), { recursive: true });
      await writeFile(join(dir, ".factory", "config.ts"), config);
    }
    const { env, err, stop, firstLine } = await cli(dir);
    const exit = main(["web", "--port", "0"], env);

    expect(await runIds(urlOf(await firstLine))).toEqual(["1-run-00 ready"]);
    stop.abort();
    expect(await exit).toBe(0);
    expect(err).toEqual([]);
  });

  it("should create a new random token each time it starts", async () => {
    const dir = await temp.make("web-cli-token-");
    const tokens: string[] = [];
    for (let started = 0; started < 2; started++) {
      const { env, stop, firstLine } = await cli(dir);
      const exit = main(["web", "--port", "0"], env);
      tokens.push(new URL(urlOf(await firstLine)).searchParams.get("token") ?? "");
      stop.abort();
      await exit;
    }

    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it("should start a web action from the browser that visited the printed URL, and record its end and output under .factory/web/", async () => {
    const dir = await temp.make("web-cli-action-");
    const { env, stop, firstLine } = await cli(dir);
    const exit = main(["web", "--port", "0"], env);
    const url = new URL(urlOf(await firstLine));
    const origin = url.origin;

    const visit = await fetch(url, { redirect: "manual" });
    expect(visit.status).toBe(303);
    const cookie = (visit.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).toMatch(/^factory-token=[0-9a-f]{64}$/);

    const started = await fetch(new URL("/api/actions", origin), {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json" },
      body: JSON.stringify({ command: "validate", issue: 28 }),
    });
    expect(started.status).toBe(202);
    const { id } = (await started.json()) as { id: string };

    let view: WebActionView | undefined;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      view = (await (await fetch(new URL(`/api/actions/${id}`, origin))).json()) as WebActionView;
      if (view.state.kind !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(view?.command).toBe("factory validate 28");
    expect(view?.state).toMatchObject({ kind: "ended", exitCode: 1 });
    expect(view?.output).toContain("config.ts");

    stop.abort();
    expect(await exit).toBe(0);
  });

  it("should start nothing for a POST without the cookie of the token, even from its own Origin", async () => {
    const dir = await temp.make("web-cli-no-token-");
    const { env, stop, firstLine } = await cli(dir);
    const exit = main(["web", "--port", "0"], env);
    const origin = new URL(urlOf(await firstLine)).origin;

    const response = await fetch(new URL("/api/actions", origin), {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ command: "doctor" }),
    });

    expect(response.status).toBe(403);
    expect(existsSync(join(dir, ".factory", "web"))).toBe(false);
    stop.abort();
    expect(await exit).toBe(0);
  });

  it("should take the target repo from the argument", async () => {
    const dir = await repoWithRuns([{ log: cleanRun(0) }]);
    const { env, firstLine } = await cli(await temp.make("web-cli-elsewhere-"));
    const exit = main(["web", dir, "--port", "0"], env);

    expect(await runIds(urlOf(await firstLine))).toEqual(["1-run-00 ready"]);
    stops[0]?.abort();
    expect(await exit).toBe(0);
  });

  it("should serve on the port of --port", async () => {
    const dir = await temp.make("web-cli-port-");
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const free = (probe.address() as { port: number }).port;
    await new Promise((resolve) => probe.close(resolve));
    const { env, stop, firstLine } = await cli(dir);
    const exit = main(["web", "--port", String(free)], env);

    expect(urlOf(await firstLine)).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${free}/\\?token=`));
    stop.abort();
    expect(await exit).toBe(0);
  });

  it("should end with a clear message and exit code 1 when the port is taken", async () => {
    const blocker = createServer();
    blockers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const taken = (blocker.address() as { port: number }).port;
    const { env, err, out } = await cli(await temp.make("web-cli-busy-"));

    expect(await main(["web", "--port", String(taken)], env)).toBe(1);
    expect(err.join("\n")).toContain(`port ${taken} is already in use`);
    expect(out).toEqual([]);
  });

  it.each([["--port", "abc"], ["--port", "70000"], ["--port", "-1"], ["a", "b"]])(
    "should print the usage when the arguments are %j",
    async (...args) => {
      const { env, err } = await cli(await temp.make("web-cli-usage-"));

      expect(await main(["web", ...args], env)).toBe(2);
      expect(err.join("\n")).toContain("factory web [target-repo] [--port <port>]");
    },
  );

  it("should list factory web in the usage of factory", async () => {
    const { env, err } = await cli(await temp.make("web-cli-help-"));

    expect(await main([], env)).toBe(2);
    expect(err.join("\n")).toContain("factory web [target-repo] [--port <port>]");
  });

  it("should serve an empty run list for a repo that has no run log", async () => {
    const { env, stop, firstLine } = await cli(await temp.make("web-cli-none-"));
    const exit = main(["web", "--port", "0"], env);

    expect(await runIds(urlOf(await firstLine))).toEqual([]);
    stop.abort();
    expect(await exit).toBe(0);
  });

  it("should refuse a request whose Host header is not the loopback address of the port", async () => {
    const { env, stop, firstLine } = await cli(await temp.make("web-cli-host-"));
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

  it.each([
    ["missing", "the web client is not built"],
    ["stale", "the build of the web client comes from older sources than the current ones"],
  ] as const)("should refuse to start with pnpm build:web as the fix when the build of the client is %s", async (state, problem) => {
    const { env, err, out } = await cli(await temp.make("web-cli-build-"), state);

    expect(await main(["web", "--port", "0"], env)).toBe(1);
    expect(err.join("\n")).toContain(problem);
    expect(err.join("\n")).toContain("→ pnpm build:web");
    expect(out).toEqual([]);
  });
});
