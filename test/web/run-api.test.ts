import { afterEach, describe, expect, it } from "vitest";
import { handleRequest } from "../../src/web/handler.ts";
import { aRun, repoWithRuns, request, runDetail, temp } from "./web-helpers.ts";

afterEach(() => temp.removeAll());

describe("the run of the API", () => {
  it("should answer the issue, the run ID and the result of the run as JSON", async () => {
    const log = aRun(0, { issue: 45, result: "ready" });

    const run = await runDetail(log);

    expect([run.issue, run.runId, run.status]).toEqual([45, log.runId, "ready"]);
  });

  it("should answer 404 as JSON to a run ID that is valid but has no run.json", async () => {
    const dir = await repoWithRuns([{ log: aRun(0) }]);

    const response = await handleRequest(request(dir, "/api/runs/45-2026-10-01T00-00-00-000Z"));

    expect(response.status).toBe(404);
    expect(JSON.parse(String(response.body))).toEqual({ error: "not found" });
  });

  it("should answer 404 to a run whose run.json cannot be read", async () => {
    const log = { ...aRun(0), version: 0 as 1 };
    const dir = await repoWithRuns([{ log }]);

    expect((await handleRequest(request(dir, `/api/runs/${log.runId}`))).status).toBe(404);
  });

  it.each(["/api/runs/..", "/api/runs/%2e%2e", "/api/runs/1-run-00", "/api/runs/%zz"])(
    "should answer 404 to %s, which is not a run ID, and read no file",
    async (path) => {
      const dir = await repoWithRuns([{ log: aRun(0) }]);

      expect((await handleRequest(request(dir, path))).status).toBe(404);
    },
  );

  it("should check the Host header and the method before it reads the run", async () => {
    const log = aRun(0);
    const dir = await repoWithRuns([{ log }]);

    expect((await handleRequest(request(dir, `/api/runs/${log.runId}`, { host: "evil.example" }))).status).toBe(403);
    expect((await handleRequest(request(dir, `/api/runs/${log.runId}`, { method: "POST" }))).status).toBe(405);
  });
});

