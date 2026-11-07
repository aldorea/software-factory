import { afterEach, describe, expect, it } from "vitest";
import type { RunLog } from "../../src/coordinator/run-log.ts";
import type { RunsResponse } from "../../src/web/api.ts";
import { handleRequest } from "../../src/web/handler.ts";
import { aRun, NOW, repoWithRuns, request, runDetail, temp } from "./web-helpers.ts";

afterEach(() => temp.removeAll());

describe("the agents of a run", () => {
  it("should give the agent and the model of each role that run.json brings", async () => {
    const log = aRun(0, {
      agents: {
        workers: { agent: "opencode", model: "opencode-go/kimi-k2" },
        verifier: { agent: "claude-code", model: "opus" },
        tester: { agent: "claude-code", model: "sonnet" },
        changes: [],
      },
    });

    const { agents } = await runDetail(log);

    expect(agents.roles).toEqual([
      { role: "workers", agent: "opencode", model: "opencode-go/kimi-k2" },
      { role: "verifier", agent: "claude-code", model: "opus" },
      { role: "tester", agent: "claude-code", model: "sonnet" },
    ]);
  });

  it("should list only the roles that run.json brings", async () => {
    const log = aRun(0, { agents: { workers: { agent: "claude-code", model: "sonnet" }, changes: [] } });

    const { agents } = await runDetail(log);

    expect(agents.roles).toEqual([{ role: "workers", agent: "claude-code", model: "sonnet" }]);
  });

  it("should give each change of agent made when the run resumed, with its role, both choices and time", async () => {
    const change = {
      role: "workers" as const,
      from: { agent: "claude-code" as const, model: "sonnet" },
      to: { agent: "opencode" as const, model: "opencode-go/kimi-k2" },
      at: "2026-10-24T07:30:00.000Z",
    };
    const log = aRun(0, { agents: { workers: { agent: "opencode", model: "opencode-go/kimi-k2" }, changes: [change] } });

    const { agents } = await runDetail(log);

    expect(agents.changes).toEqual([change]);
  });
});

describe("the criteria of a run", () => {
  it("should give the passing, blocked, human and pending criteria, each even when empty, because the run still reports it", async () => {
    const criteria = { passing: ["C1", "C2"], blocked: [], human: ["C4"], pending: ["C5", "C6"] };

    expect((await runDetail(aRun(0, { criteria }))).criteria).toEqual(criteria);
  });
});

describe("the last change of a run", () => {
  it("should give the time of the last change of run.json and the now of the server, so the client draws the age", async () => {
    const { endedAt: _ended, ...base } = aRun(0);
    const log: RunLog = { ...base, result: "running" };
    const modifiedAt = new Date(NOW.getTime() - 7 * 60_000);

    const run = await runDetail(log, modifiedAt);

    expect(run.status).toBe("running");
    expect(run.modifiedAt).toBe(modifiedAt.toISOString());
    expect(run.now).toBe(NOW.toISOString());
  });
});

describe("the pause of a run", () => {
  it("should give the reason and the time when the plan limit resets", async () => {
    const log = aRun(0, { result: "paused", pauseReason: "the plan limit of claude-code was reached", resetsAt: "2026-10-24T13:00:00.000Z" });

    expect((await runDetail(log)).pause).toEqual({ reason: "the plan limit of claude-code was reached", resetsAt: "2026-10-24T13:00:00.000Z" });
  });

  it("should give no reset time when run.json has none, so the client says it is unknown", async () => {
    const log = aRun(0, { result: "paused", pauseReason: "the plan limit of claude-code was reached" });

    expect((await runDetail(log)).pause).toEqual({ reason: "the plan limit of claude-code was reached", resetsAt: null });
  });

  it("should give no pause for a run that is not paused", async () => {
    expect((await runDetail(aRun(0))).pause).toBeNull();
  });
});

describe("the block of a run", () => {
  it("should give the type, the reason, the sha and the checks of an integration-check block, with the first error of a failed check", async () => {
    const log = aRun(0, {
      result: "draft",
      block: {
        type: "integration-check",
        reason: "the checks failed on the integration branch",
        sha: "abc1234",
        checks: [
          { name: "typecheck", command: "pnpm typecheck", exitCode: 0, passed: true },
          { name: "unit-tests", command: "pnpm test", exitCode: 1, passed: false, firstError: "2 tests failed" },
        ],
      },
    });

    expect((await runDetail(log)).block).toEqual({
      type: "integration-check",
      reason: "the checks failed on the integration branch",
      sha: "abc1234",
      files: [],
      checks: [
        { name: "typecheck", command: "pnpm typecheck", exitCode: 0, passed: true, firstError: null, output: null, outputUrl: null },
        { name: "unit-tests", command: "pnpm test", exitCode: 1, passed: false, firstError: "2 tests failed", output: null, outputUrl: null },
      ],
    });
  });

  it("should give the type, the reason and the files of a default-branch-conflict block", async () => {
    const log = aRun(0, {
      result: "draft",
      block: { type: "default-branch-conflict", reason: "the default branch moved and the merge conflicts", sha: "def5678", files: ["src/a.ts", "src/b.ts"] },
    });

    expect((await runDetail(log)).block).toEqual({
      type: "default-branch-conflict",
      reason: "the default branch moved and the merge conflicts",
      sha: "def5678",
      files: ["src/a.ts", "src/b.ts"],
      checks: [],
    });
  });

  it("should give no block for a run without one", async () => {
    expect((await runDetail(aRun(0))).block).toBeNull();
  });
});

describe("the causes of a run that works", () => {
  it("should give no block, pause or publication failure while the run is running, since Summary then shows only its current step", async () => {
    const log = aRun(0, {
      result: "running",
      block: { type: "default-branch-conflict", reason: "the default branch moved and the merge conflicts", sha: "def5678", files: ["src/a.ts"] },
      publicationFailure: { phase: "integration-push", message: "rejected", at: "2026-10-24T09:00:00.000Z" },
    });

    const run = await runDetail(log);

    expect([run.status, run.block, run.pause, run.publicationFailure]).toEqual(["running", null, null, null]);
  });
});

describe("the pull request and the evidence branch of a run", () => {
  it("should link the pull request and the evidence branch of a ready run", async () => {
    const log = aRun(0, {
      pullRequest: { number: 52, url: "https://github.com/acme/app/pull/52", draft: false },
      evidence: { branch: "factory-evidence/45", commit: "abc1234", repositoryUrl: "https://github.com/acme/app" },
    });

    const run = await runDetail(log);

    expect(run.pullRequest).toEqual({ number: 52, url: "https://github.com/acme/app/pull/52", draft: false });
    expect(run.evidenceBranch).toEqual({ branch: "factory-evidence/45", url: "https://github.com/acme/app/tree/factory-evidence/45" });
  });

  it("should say that the pull request is a draft", async () => {
    const log = aRun(0, { pullRequest: { number: 52, url: "https://github.com/acme/app/pull/52", draft: true } });

    expect((await runDetail(log)).pullRequest?.draft).toBe(true);
  });

  it("should give neither when the run has no pull request and no evidence branch", async () => {
    const run = await runDetail(aRun(0));

    expect(run.pullRequest).toBeNull();
    expect(run.evidenceBranch).toBeNull();
  });

  it("should give the evidence branch with no link when run.json keeps no repository URL", async () => {
    expect((await runDetail(aRun(0, { evidence: { branch: "factory-evidence/45" } }))).evidenceBranch).toEqual({ branch: "factory-evidence/45", url: null });
  });

  it("should give no url that is not http or https, because a javascript: link runs when clicked even if it is escaped", async () => {
    const log = aRun(0, {
      pullRequest: { number: 1, url: "javascript:alert(1)", draft: false },
      evidence: { branch: "b", repositoryUrl: "javascript:alert(2)" },
    });

    const run = await runDetail(log);

    expect(run.pullRequest?.url).toBeNull();
    expect(run.evidenceBranch?.url).toBeNull();
  });
});

describe("the refresh of the page of a run", () => {
  it("should say the run is in progress while it is running, so the client keeps asking", async () => {
    expect((await runDetail(aRun(0, { result: "running" }))).inProgress).toBe(true);
  });

  it.each(["ready", "draft", "paused"] as const)("should say the run is not in progress when it is %s, so the page can be read without jumps", async (result) => {
    expect((await runDetail(aRun(0, { result }))).inProgress).toBe(false);
  });

  it("should not keep asking for a finished run because another run is running", async () => {
    const finished = aRun(0, { result: "ready" });
    const dir = await repoWithRuns([{ log: finished }, { log: aRun(1, { result: "running" }) }]);

    const response = await handleRequest(request(dir, `/api/runs/${finished.runId}`));

    expect(JSON.parse(String(response.body)).inProgress).toBe(false);
  });
});

describe("the page of a run", () => {
  it("should give the page of the client for the URL of a run, so the link of a notification keeps working", async () => {
    const log = aRun(0);
    const dir = await repoWithRuns([{ log }]);

    const response = await handleRequest(request(dir, `/runs/${log.runId}`));

    expect(response.status).toBe(200);
    expect(response.contentType).toBe("text/html; charset=utf-8");
    expect(response.body).toContain('<div id="root"></div>');
  });

  it("should give the page of the client for a run ID with no run.json, whose not found page the client draws from the API", async () => {
    const dir = await repoWithRuns([{ log: aRun(0) }]);

    const response = await handleRequest(request(dir, "/runs/45-2026-10-01T00-00-00-000Z"));

    expect(response.body).toContain('<div id="root"></div>');
  });

  it.each(["/runs/..", "/runs/%2e%2e", "/runs/..%2F..%2Fetc", "/runs/1-run-00", "/runs/%zz"])(
    "should give the path %s, which is not a run ID, to the client, which draws its not found page",
    async (path) => {
      const dir = await repoWithRuns([{ log: aRun(0) }]);

      const response = await handleRequest(request(dir, path));

      expect(response.status).toBe(200);
      expect(response.body).toContain('<div id="root"></div>');
    },
  );

  it("should answer 404 to a path below a run ID that is not the format of a run ID, because it reads no file", async () => {
    const dir = await repoWithRuns([{ log: aRun(0) }]);

    expect((await handleRequest(request(dir, "/runs/a/b"))).status).toBe(404);
  });

  it("should check the Host header and the method of the page of a run", async () => {
    const log = aRun(0);
    const dir = await repoWithRuns([{ log }]);

    expect((await handleRequest(request(dir, `/runs/${log.runId}`, { host: "evil.example" }))).status).toBe(403);
    expect((await handleRequest(request(dir, `/runs/${log.runId}`, { method: "POST" }))).status).toBe(405);
  });
});

describe("the links from the list of runs", () => {
  it("should link each run to a run that the API serves", async () => {
    const log = aRun(0);
    const dir = await repoWithRuns([{ log }]);
    const { runs } = JSON.parse(String((await handleRequest(request(dir, "/api/runs"))).body)) as RunsResponse;

    expect(runs[0]?.href).toBe(`/runs/${log.runId}`);
    expect((await handleRequest(request(dir, `/api${runs[0]?.href as string}`))).status).toBe(200);
  });
});
