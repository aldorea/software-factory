import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunsResponse } from "../../src/web/api.ts";
import { handleRequest } from "../../src/web/handler.ts";
import { cleanRun, failedRun, pausedRun } from "../coordinator/run-log-fixtures.ts";
import { CLIENT_DIR, NOW, PORT, aRun, repoWithRuns, request, temp } from "./web-helpers.ts";

afterEach(() => temp.removeAll());

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 3_600_000);
}

async function runsOf(repoDir: string): Promise<RunsResponse> {
  const response = await handleRequest(request(repoDir, "/api/runs"));
  expect(response.status).toBe(200);
  expect(response.contentType).toBe("application/json; charset=utf-8");
  return JSON.parse(String(response.body)) as RunsResponse;
}

describe("the list of runs of the API", () => {
  it("should list the runs from the most recent to the oldest with issue, run ID, result, link and pull request", async () => {
    const oldest = { ...cleanRun(0), issue: 11, pullRequest: { number: 5, url: "https://github.com/acme/app/pull/5", draft: false } };
    const newest = { ...failedRun(1), issue: 12, result: "draft" as const };
    const dir = await repoWithRuns([{ log: oldest }, { log: newest }]);

    const { runs } = await runsOf(dir);

    expect(runs.map((row) => [row.issue, row.runId, row.status])).toEqual([
      [12, newest.runId, "draft"],
      [11, oldest.runId, "ready"],
    ]);
    expect(runs[1]?.pullRequest).toEqual({ kind: "pull-request", number: 5, url: "https://github.com/acme/app/pull/5" });
    expect(runs[0]?.pullRequest).toEqual({ kind: "none" });
  });

  it("should link the page of a run only when its folder has the format of a run ID", async () => {
    const linked = aRun(0);
    const dir = await repoWithRuns([{ log: linked }, { log: cleanRun(1) }]);

    const { runs } = await runsOf(dir);

    expect(runs.map((row) => row.href)).toEqual([null, `/runs/${linked.runId}`]);
  });

  it("should give the time of the last change of each run.json and the now of the server, so the client draws the age", async () => {
    const dir = await repoWithRuns([{ log: cleanRun(0), modifiedAt: hoursAgo(3) }]);

    const response = await runsOf(dir);

    expect(response.now).toBe(NOW.toISOString());
    expect(response.runs[0]?.modifiedAt).toBe(hoursAgo(3).toISOString());
  });

  it("should list a run.json that cannot be read apart from the runs", async () => {
    const dir = await repoWithRuns([{ log: cleanRun(0) }, { log: { ...cleanRun(1), version: 0 as 1 } }]);

    const response = await runsOf(dir);

    expect(response.runs.map((row) => row.runId)).toEqual(["1-run-00"]);
    expect(response.unreadable).toEqual(["1-run-01/run.json"]);
  });

  it("should answer an empty list with no statistics for a target repo without a run log, not an error", async () => {
    const dir = await temp.make("web-empty-");

    expect(await runsOf(dir)).toEqual({ now: NOW.toISOString(), runs: [], unreadable: [], stats: null, inProgress: false });
  });

  it("should give no url for a pull request whose url is not http or https, because a javascript: link runs when clicked", async () => {
    const hostile = { ...cleanRun(0), pullRequest: { number: 1, url: "javascript:alert(1)", draft: false } };
    const dir = await repoWithRuns([{ log: hostile }]);

    expect((await runsOf(dir)).runs[0]?.pullRequest).toEqual({ kind: "pull-request", number: 1, url: null });
  });

  it("should say a run is in progress while one is running, so the client keeps asking", async () => {
    const running = await repoWithRuns([{ log: aRun(0, { result: "ready" }) }, { log: aRun(1, { result: "running" }) }]);
    const idle = await repoWithRuns([{ log: aRun(0, { result: "ready" }) }, { log: aRun(1, { result: "paused" }) }]);

    expect((await runsOf(running)).inProgress).toBe(true);
    expect((await runsOf(idle)).inProgress).toBe(false);
  });

  it("should not count as in progress a running run whose process died, because it is abandoned", async () => {
    const dir = await repoWithRuns([{ log: aRun(0, { result: "running" }), modifiedAt: hoursAgo(1) }]);

    const response = await runsOf(dir);

    expect(response.runs[0]?.status).toBe("abandoned");
    expect(response.inProgress).toBe(false);
  });
});

describe("the statistics of the API", () => {
  it("should count the runs of each result, as factory stats does", async () => {
    const dir = await repoWithRuns([
      { log: cleanRun(0) },
      { log: cleanRun(1) },
      { log: { ...failedRun(2), result: "draft" } },
      { log: pausedRun(3) },
    ]);

    const { stats } = await runsOf(dir);

    expect(stats?.runs).toBe(4);
    expect(stats?.results).toEqual({ ready: 2, draft: 1, paused: 1, running: 0, abandoned: 0 });
  });

  it("should give the statistics of the readable runs when some run.json cannot be read", async () => {
    const dir = await repoWithRuns([{ log: cleanRun(0) }, { log: { ...cleanRun(1), version: 0 as 1 } }]);

    expect((await runsOf(dir)).stats?.runs).toBe(1);
  });

  it("should give the failures of the worker layer in the order of their kinds, not in the order they happened", async () => {
    const failure = failedRun(1).workerLayerFailures[0] as ReturnType<typeof failedRun>["workerLayerFailures"][number];
    const dir = await repoWithRuns([{ log: { ...failedRun(0), workerLayerFailures: [{ ...failure, kind: "process-hang" }, failure] } }]);

    expect(Object.keys((await runsOf(dir)).stats?.workerLayerFailures ?? {})).toEqual(["container-start", "process-hang"]);
  });
});

describe("the page of the client", () => {
  it.each(["/", "/live", "/board", "/settings", "/nope", "/runs", "/runs/not-a-run-id", "/apis"])(
    "should serve the page of the client for %s, which draws the page of that URL or its not found page",
    async (path) => {
      const dir = await temp.make("web-client-");

      const response = await handleRequest(request(dir, path));

      expect(response.status).toBe(200);
      expect(response.contentType).toBe("text/html; charset=utf-8");
      expect(response.body).toBe(await readFile(join(CLIENT_DIR, "index.html"), "utf8"));
    },
  );

  it("should serve the scripts and styles of the client by their type", async () => {
    const dir = await temp.make("web-assets-");

    const script = await handleRequest(request(dir, "/assets/app.js"));
    const style = await handleRequest(request(dir, "/assets/app.css"));

    expect([script.status, script.contentType]).toEqual([200, "text/javascript; charset=utf-8"]);
    expect(script.body).toContain("fixture");
    expect([style.status, style.contentType]).toEqual([200, "text/css; charset=utf-8"]);
  });

  it.each(["/assets/missing.js", "/assets/app.txt", "/assets/%2e%2e/index.html", "/assets/../index.html", "/assets/"])(
    "should answer 404 to %s, because only the files of the build are served",
    async (path) => {
      const dir = await temp.make("web-assets-");

      expect((await handleRequest(request(dir, path))).status).toBe(404);
    },
  );
});

describe("what the handler refuses", () => {
  it.each(["evil.example:7433", "127.0.0.1:9999", "127.0.0.1", "localhost", "localhost:7433.evil.example", ""])(
    "should answer 403 to the Host header %j on every path, the API included, against DNS rebinding",
    async (host) => {
      const dir = await temp.make("web-host-");

      for (const path of ["/", "/api/runs", "/assets/app.js", "/runs/45-2026-10-24T08-00-00-000Z"]) {
        expect((await handleRequest(request(dir, path, { host }))).status).toBe(403);
      }
    },
  );

  it("should answer 403 to a request with no Host header", async () => {
    const dir = await temp.make("web-host-");

    expect((await handleRequest(request(dir, "/api/runs", { host: undefined }))).status).toBe(403);
  });

  it.each([`127.0.0.1:${PORT}`, `localhost:${PORT}`])("should accept the Host header %s", async (host) => {
    const dir = await temp.make("web-host-");

    expect((await handleRequest(request(dir, "/api/runs", { host }))).status).toBe(200);
  });

  it.each(["POST", "PUT", "DELETE", "PATCH", "HEAD"])("should answer 405 in JSON to the method %s on the API, because the API only reads", async (method) => {
    const dir = await temp.make("web-method-");

    const response = await handleRequest(request(dir, "/api/runs", { method }));

    expect(response.status).toBe(405);
    expect(JSON.parse(String(response.body))).toEqual({ error: "method not allowed" });
  });

  it.each(["POST", "PUT", "DELETE", "HEAD"])("should answer 405 to the method %s on a page", async (method) => {
    const dir = await temp.make("web-method-");

    expect((await handleRequest(request(dir, "/", { method }))).status).toBe(405);
  });

  it.each(["/api", "/api/", "/api/nope", "/api/runs/extra"])("should answer 404 in JSON to the unknown API path %s", async (path) => {
    const dir = await temp.make("web-api-");

    const response = await handleRequest(request(dir, path));

    expect(response.status).toBe(404);
    expect(JSON.parse(String(response.body))).toEqual({ error: "not found" });
  });

  it("should check the Host header before the method and the path", async () => {
    const dir = await temp.make("web-order-");

    expect((await handleRequest(request(dir, "/", { host: "evil.example", method: "POST", path: "/api/nope" }))).status).toBe(403);
  });
});
