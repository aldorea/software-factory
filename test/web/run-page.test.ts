import { afterEach, describe, expect, it } from "vitest";
import type { RunLog } from "../../src/coordinator/run-log.ts";
import { handleRequest } from "../../src/web/handler.ts";
import { cleanRun } from "../coordinator/run-log-fixtures.ts";
import { aRun, NOW, repoWithRuns, request, runPage, temp, visibleText } from "./web-helpers.ts";

afterEach(() => temp.removeAll());

describe("the agents of a run", () => {
  it("should show the agent and the model of each role that run.json brings", async () => {
    const log = aRun(0, {
      agents: {
        workers: { agent: "opencode", model: "opencode-go/kimi-k2" },
        verifier: { agent: "claude-code", model: "opus" },
        tester: { agent: "claude-code", model: "sonnet" },
        changes: [],
      },
    });

    const body = await runPage(log);

    expect(body).toContain("workers: opencode / opencode-go/kimi-k2");
    expect(body).toContain("verifier: claude-code / opus");
    expect(body).toContain("tester: claude-code / sonnet");
  });

  it("should list only the roles that run.json brings", async () => {
    const log = aRun(0, { agents: { workers: { agent: "claude-code", model: "sonnet" }, changes: [] } });

    const body = await runPage(log);

    expect(body).toContain("workers: claude-code / sonnet");
    expect(body).not.toContain("verifier:");
    expect(body).not.toContain("tester:");
  });

  it("should show each change of agent made when the run resumed, with its role, both choices and time", async () => {
    const log = aRun(0, {
      agents: {
        workers: { agent: "opencode", model: "opencode-go/kimi-k2" },
        changes: [
          {
            role: "workers",
            from: { agent: "claude-code", model: "sonnet" },
            to: { agent: "opencode", model: "opencode-go/kimi-k2" },
            at: "2026-10-24T07:30:00.000Z",
          },
        ],
      },
    });

    const body = await runPage(log);

    expect(body).toContain("Cambios de agente");
    expect(body).toContain("workers: claude-code / sonnet");
    expect(body).toContain("opencode / opencode-go/kimi-k2");
    expect(body).toContain("2026-10-24T07:30:00.000Z");
  });

  it("should not show a section of agent changes when the run never changed agent", async () => {
    const body = await runPage(aRun(0));

    expect(body).not.toContain("Cambios de agente");
  });
});

describe("the criteria of a run", () => {
  it("should show the passing, blocked, human and pending criteria each under its own heading", async () => {
    const log = aRun(0, { criteria: { passing: ["C1", "C2"], blocked: ["C3"], human: ["C4"], pending: ["C5", "C6"] } });

    const body = await runPage(log);

    const section = (heading: string, next: string | null): string => {
      const start = body.indexOf(`<h3>${heading}</h3>`);
      expect(start).toBeGreaterThan(-1);
      return body.slice(start, next === null ? undefined : body.indexOf(`<h3>${next}</h3>`));
    };
    expect(section("Pasan", "Bloqueados")).toMatch(/C1[\s\S]*C2/);
    expect(section("Bloqueados", "Human")).toContain("C3");
    expect(section("Human", "Pendientes")).toContain("C4");
    expect(section("Pendientes", null)).toMatch(/C5[\s\S]*C6/);
    expect(section("Pasan", "Bloqueados")).not.toContain("C3");
  });

  it("should show a heading with no criteria as empty, because the run still reports it", async () => {
    const log = aRun(0, { criteria: { passing: ["C1"], blocked: [], human: [], pending: [] } });

    const body = await runPage(log);

    expect(body).toContain("<h3>Bloqueados</h3>");
    expect(body).toContain("Ninguno");
  });
});

describe("the last change of a run", () => {
  it("should show the age of run.json relative to now for a running run", async () => {
    const { endedAt: _ended, ...base } = aRun(0);
    const log: RunLog = { ...base, result: "running" };

    const body = await runPage(log, new Date(NOW.getTime() - 7 * 60_000));

    expect(body).toContain("running");
    expect(body).toContain("Último cambio");
    expect(body).toContain("hace 7 min");
  });
});

describe("the pause of a run", () => {
  it("should show the reason and the time when the plan limit resets", async () => {
    const log = aRun(0, {
      result: "paused",
      pauseReason: "the plan limit of claude-code was reached",
      resetsAt: "2026-10-24T13:00:00.000Z",
    });

    const body = await runPage(log);

    expect(body).toContain("the plan limit of claude-code was reached");
    expect(body).toContain("2026-10-24T13:00:00.000Z");
  });

  it("should say that the reset time is unknown when run.json has none", async () => {
    const log = aRun(0, { result: "paused", pauseReason: "the plan limit of claude-code was reached" });

    const body = await runPage(log);

    expect(body).toContain("the plan limit of claude-code was reached");
    expect(body).toContain("Reset del plan limit: desconocido");
  });

  it("should show no pause for a run that is not paused", async () => {
    const body = await runPage(aRun(0));

    expect(body).not.toContain("Pausado");
  });
});

describe("the block of a run", () => {
  it("should show the type and the reason of an integration-check block with its checks", async () => {
    const log = aRun(0, {
      result: "draft",
      block: {
        type: "integration-check",
        reason: "the checks failed on the integration branch",
        sha: "abc1234",
        checks: [
          { name: "typecheck", command: "pnpm typecheck", exitCode: 0, passed: true },
          { name: "unit-tests", command: "pnpm test", exitCode: 1, passed: false },
        ],
      },
    });

    const body = await runPage(log);

    expect(body).toContain("Bloqueo del run");
    expect(body).toContain("integration-check");
    expect(body).toContain("the checks failed on the integration branch");
    expect(body).toContain("abc1234");
    expect(body).toContain("unit-tests");
  });

  it("should show the first error of a failed check of an integration-check block, as it does for the checks of a gate", async () => {
    const log = aRun(0, {
      result: "draft",
      block: {
        type: "integration-check",
        reason: "the checks failed on the integration branch",
        sha: "abc1234",
        checks: [{ name: "unit-tests", command: "pnpm test", exitCode: 1, passed: false, firstError: "2 tests failed" }],
      },
    });

    expect(visibleText(await runPage(log))).toContain("unit-tests: falla (2 tests failed)");
  });

  it("should show the type, the reason and the files of a default-branch-conflict block", async () => {
    const log = aRun(0, {
      result: "draft",
      block: {
        type: "default-branch-conflict",
        reason: "the default branch moved and the merge conflicts",
        sha: "def5678",
        files: ["src/a.ts", "src/b.ts"],
      },
    });

    const body = await runPage(log);

    expect(body).toContain("default-branch-conflict");
    expect(body).toContain("the default branch moved and the merge conflicts");
    expect(body).toContain("src/a.ts");
    expect(body).toContain("src/b.ts");
  });

  it("should show no block for a run without one", async () => {
    const body = await runPage(aRun(0));

    expect(body).not.toContain("Bloqueo del run");
  });
});

describe("the pull request and the evidence branch of a run", () => {
  it("should link the pull request and the evidence branch of a ready run", async () => {
    const log = aRun(0, {
      pullRequest: { number: 52, url: "https://github.com/acme/app/pull/52", draft: false },
      evidence: { branch: "factory-evidence/45", commit: "abc1234", repositoryUrl: "https://github.com/acme/app" },
    });

    const body = await runPage(log);

    expect(body).toContain('<a href="https://github.com/acme/app/pull/52">#52</a>');
    expect(body).toContain('<a href="https://github.com/acme/app/tree/factory-evidence/45">factory-evidence/45</a>');
  });

  it("should say that the pull request is a draft", async () => {
    const log = aRun(0, { pullRequest: { number: 52, url: "https://github.com/acme/app/pull/52", draft: true } });

    const body = await runPage(log);

    expect(body).toContain("#52</a> (draft)");
  });

  it("should show the failure of the evidence branch when it was not pushed", async () => {
    const log = aRun(0, { evidence: { branch: "factory-evidence/45", failure: "push rejected" } });

    const body = await runPage(log);

    expect(body).toContain("factory-evidence/45");
    expect(body).toContain("push rejected");
    expect(body).not.toContain('href="undefined');
  });

  it("should show neither when the run has no pull request and no evidence branch", async () => {
    const body = await runPage(aRun(0));

    expect(body).not.toContain("Pull request");
    expect(body).not.toContain("Evidence branch");
  });

  it("should not link a url that is not http or https, because an escaped javascript: link still runs", async () => {
    const log = aRun(0, {
      pullRequest: { number: 1, url: "javascript:alert(1)", draft: false },
      evidence: { branch: "b", repositoryUrl: "javascript:alert(2)" },
    });

    const body = await runPage(log);

    expect(body).not.toContain('href="javascript:');
    expect(body).not.toContain("javascript:alert(2)");
  });
});

describe("the escaping of a run", () => {
  it("should escape the HTML characters of every text that comes from run.json", async () => {
    const hostile = "<script>alert(1)</script>";
    const log = aRun(0, {
      result: "paused",
      pauseReason: hostile,
      resetsAt: hostile,
      agents: {
        workers: { agent: "claude-code", model: hostile },
        changes: [
          { role: "workers", from: { agent: "claude-code", model: hostile }, to: { agent: "opencode", model: hostile }, at: hostile },
        ],
      },
      criteria: { passing: [hostile], blocked: [hostile], human: [hostile], pending: [hostile] },
      block: { type: "default-branch-conflict", reason: hostile, sha: hostile, files: [hostile] },
      pullRequest: { number: 1, url: `https://x.test/"><script>alert(1)</script>`, draft: false },
      evidence: { branch: hostile, repositoryUrl: `https://x.test/"><script>alert(1)</script>`, failure: hostile },
    });

    const body = await runPage(log);

    expect(body).not.toContain("<script>alert(1)");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("the links from the home page", () => {
  it("should link each run of the list to its page", async () => {
    const first = aRun(0);
    const second = aRun(1);
    const dir = await repoWithRuns([{ log: first }, { log: second }]);

    const { body } = await handleRequest(request(dir, "/"));

    expect(body).toContain(`<a href="/runs/${first.runId}">${first.runId}</a>`);
    expect(body).toContain(`<a href="/runs/${second.runId}">${second.runId}</a>`);
  });

  it("should serve the page that each link of the home page points to", async () => {
    const log = aRun(0);
    const dir = await repoWithRuns([{ log }]);
    const home = await handleRequest(request(dir, "/"));
    const href = /href="(\/runs\/[^"]+)"/.exec(home.body)?.[1];

    expect(href).toBeDefined();
    expect((await handleRequest(request(dir, href as string))).status).toBe(200);
  });

  it("should not link a run whose directory is not a run ID, because its page would answer 404", async () => {
    const dir = await repoWithRuns([{ log: { ...cleanRun(0), runId: "1-run-00" } }]);

    const { body } = await handleRequest(request(dir, "/"));

    expect(body).toContain("1-run-00");
    expect(body).not.toContain('href="/runs/');
  });
});

describe("the page of a run", () => {
  it("should show the issue, the run ID and the result of the run", async () => {
    const log = aRun(0, { issue: 45, result: "ready" });

    const body = await runPage(log);

    expect(body).toContain("#45");
    expect(body).toContain(log.runId);
    expect(body).toContain("ready");
  });

  it("should answer 404 to a run ID that is valid but has no run.json", async () => {
    const dir = await repoWithRuns([{ log: aRun(0) }]);

    const response = await handleRequest(request(dir, "/runs/45-2026-10-01T00-00-00-000Z"));

    expect(response.status).toBe(404);
  });

  it.each(["/runs/..", "/runs/%2e%2e", "/runs/..%2F..%2Fetc", "/runs/a/b", "/runs/1-run-00", "/runs/%zz"])(
    "should answer 404 to the path %s, which is not a run ID",
    async (path) => {
      const dir = await repoWithRuns([{ log: aRun(0) }]);

      expect((await handleRequest(request(dir, path))).status).toBe(404);
    },
  );

  it("should answer 404 to a run whose run.json cannot be read", async () => {
    const log = { ...aRun(0), version: 0 as 1 };
    const dir = await repoWithRuns([{ log }]);

    expect((await handleRequest(request(dir, `/runs/${log.runId}`))).status).toBe(404);
  });

  it("should check the Host header and the method before it reads the run", async () => {
    const log = aRun(0);
    const dir = await repoWithRuns([{ log }]);

    expect((await handleRequest(request(dir, `/runs/${log.runId}`, { host: "evil.example" }))).status).toBe(403);
    expect((await handleRequest(request(dir, `/runs/${log.runId}`, { method: "POST" }))).status).toBe(405);
  });
});
