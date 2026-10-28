import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeRunLog, type RunLog } from "../../src/coordinator/run-log.ts";
import { handleRequest, type WebRequest } from "../../src/web/handler.ts";
import { cleanRun, failedRun, pausedRun } from "../coordinator/run-log-fixtures.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

const NOW = new Date("2026-10-24T08:00:00.000Z");
const PORT = 7433;

async function repoWithRuns(runs: Array<{ log: RunLog; modifiedAt?: Date }>): Promise<string> {
  const dir = await temp.make("web-repo-");
  for (const { log, modifiedAt } of runs) {
    const path = join(dir, ".factory", "logs", log.runId, "run.json");
    await writeRunLog(path, log);
    if (modifiedAt) await utimes(path, modifiedAt, modifiedAt);
  }
  return dir;
}

function request(repoDir: string, overrides: Partial<WebRequest> = {}): WebRequest {
  return { method: "GET", path: "/", host: `127.0.0.1:${PORT}`, repoDir, port: PORT, now: NOW, ...overrides };
}

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 3_600_000);
}

describe("the home page", () => {
  it("should list the runs from the most recent to the oldest with issue, run ID, result and pull request", async () => {
    const oldest = { ...cleanRun(0), issue: 11, pullRequest: { number: 5, url: "https://github.com/acme/app/pull/5", draft: false } };
    const newest = { ...failedRun(1), issue: 12, result: "draft" as const };
    const dir = await repoWithRuns([{ log: oldest }, { log: newest }]);

    const response = await handleRequest(request(dir));

    expect(response.status).toBe(200);
    expect(response.contentType).toBe("text/html; charset=utf-8");
    expect(response.body.indexOf(newest.runId)).toBeGreaterThan(-1);
    expect(response.body.indexOf(newest.runId)).toBeLessThan(response.body.indexOf(oldest.runId));
    expect(response.body).toContain("#12");
    expect(response.body).toContain("#11");
    expect(response.body).toContain("draft");
    expect(response.body).toContain('href="https://github.com/acme/app/pull/5"');
  });

  it("should show the last change of each run as the age of its run.json relative to now", async () => {
    const dir = await repoWithRuns([
      { log: cleanRun(0), modifiedAt: hoursAgo(3) },
      { log: cleanRun(1), modifiedAt: new Date(NOW.getTime() - 5 * 60_000) },
      { log: cleanRun(2), modifiedAt: hoursAgo(50) },
    ]);

    const { body } = await handleRequest(request(dir));

    expect(body).toContain("hace 3 h");
    expect(body).toContain("hace 5 min");
    expect(body).toContain("hace 2 d");
  });

  it("should list a run.json that cannot be read apart from the runs", async () => {
    const dir = await repoWithRuns([{ log: cleanRun(0) }, { log: { ...cleanRun(1), version: 0 as 1 } }]);

    const { body } = await handleRequest(request(dir));

    expect(body).toContain("run.json ilegibles");
    expect(body.indexOf("1-run-01/run.json")).toBeGreaterThan(body.indexOf("run.json ilegibles"));
    expect(body.indexOf("1-run-00")).toBeLessThan(body.indexOf("run.json ilegibles"));
  });

  it("should answer 200 with an empty page for a target repo without a run log", async () => {
    const dir = await temp.make("web-empty-");

    const response = await handleRequest(request(dir));

    expect(response.status).toBe(200);
    expect(response.body).toContain("Todavía no hay runs");
  });

  it("should escape the HTML characters of the text that comes from run.json", async () => {
    const hostile = { ...cleanRun(0), pullRequest: { number: 1, url: 'https://x.test/"><script>alert(1)</script>', draft: false } };
    const dir = await repoWithRuns([{ log: hostile }, { log: { ...cleanRun(1), version: 0 as 1, runId: "<img src=x onerror=alert(1)>" } }]);

    const { body } = await handleRequest(request(dir));

    expect(body).not.toContain("<script>alert(1)");
    expect(body).not.toContain("<img src=x");
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;/run.json");
  });

  it("should not link a pull request url that is not http or https, because an escaped javascript: link still runs", async () => {
    const hostile = { ...cleanRun(0), pullRequest: { number: 1, url: "javascript:alert(1)", draft: false } };
    const dir = await repoWithRuns([{ log: hostile }]);

    const { body } = await handleRequest(request(dir));

    expect(body).not.toContain('href="javascript:');
  });

  it("should serve a page that needs no JavaScript", async () => {
    const dir = await repoWithRuns([{ log: cleanRun(0) }]);

    const { body } = await handleRequest(request(dir));

    expect(body).not.toContain("<script");
  });
});

function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}

describe("the statistics of the home page", () => {
  it("should show the number of runs for each result above the list of runs", async () => {
    const dir = await repoWithRuns([
      { log: cleanRun(0) },
      { log: cleanRun(1) },
      { log: { ...failedRun(2), result: "draft" } },
      { log: pausedRun(3) },
    ]);

    const { body } = await handleRequest(request(dir));
    const text = visibleText(body);

    expect(text).toContain("Runs 4");
    expect(text).toContain("Ready 2");
    expect(text).toContain("Draft 1");
    expect(text).toContain("Paused 1");
    expect(text).toContain("Running 0");
    expect(body.indexOf("Ready")).toBeLessThan(body.indexOf("1-run-03"));
  });

  it("should show the cost, the agents, the friction and the worker layer failures of the run log", async () => {
    const dir = await repoWithRuns([{ log: cleanRun(0) }, { log: failedRun(1, "opencode") }]);

    const text = visibleText((await handleRequest(request(dir))).body);

    expect(text).toContain("Tokens 300 (150 por run");
    expect(text).toContain("opencode 1 1 150 0");
    expect(text).toContain("Bloqueos ninguno");
    expect(text).toContain("Fallos de la worker layer container-start 1");
  });

  it("should show no statistics for a target repo without a run log", async () => {
    const dir = await temp.make("web-empty-stats-");

    const { status, body } = await handleRequest(request(dir));

    expect(status).toBe(200);
    expect(body).not.toContain("Estadísticas");
  });

  it("should show the statistics of the readable runs when some run.json cannot be read", async () => {
    const dir = await repoWithRuns([{ log: cleanRun(0) }, { log: { ...cleanRun(1), version: 0 as 1 } }]);

    expect(visibleText((await handleRequest(request(dir))).body)).toContain("Runs 1");
  });
});

describe("what the handler refuses", () => {
  it.each(["evil.example:7433", "127.0.0.1:9999", "127.0.0.1", "localhost", "localhost:7433.evil.example", ""])(
    "should answer 403 to the Host header %j, against DNS rebinding",
    async (host) => {
      const dir = await temp.make("web-host-");

      expect((await handleRequest(request(dir, { host }))).status).toBe(403);
    },
  );

  it("should answer 403 to a request with no Host header", async () => {
    const dir = await temp.make("web-host-");

    expect((await handleRequest(request(dir, { host: undefined }))).status).toBe(403);
  });

  it.each([`127.0.0.1:${PORT}`, `localhost:${PORT}`])("should accept the Host header %s", async (host) => {
    const dir = await temp.make("web-host-");

    expect((await handleRequest(request(dir, { host }))).status).toBe(200);
  });

  it.each(["POST", "PUT", "DELETE", "HEAD"])("should answer 405 to the method %s", async (method) => {
    const dir = await temp.make("web-method-");

    expect((await handleRequest(request(dir, { method }))).status).toBe(405);
  });

  it("should answer 404 to an unknown path", async () => {
    const dir = await temp.make("web-path-");

    expect((await handleRequest(request(dir, { path: "/nope" }))).status).toBe(404);
  });

  it("should check the Host header before the method and the path", async () => {
    const dir = await temp.make("web-order-");

    expect((await handleRequest(request(dir, { host: "evil.example", method: "POST", path: "/nope" }))).status).toBe(403);
  });
});
