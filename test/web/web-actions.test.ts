import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseRoleFlag, ROLE_FLAGS } from "../../src/config/roles.ts";
import { handleRequest, type WebResponse } from "../../src/web/handler.ts";
import { processStartTime } from "../../src/web/process-start.ts";
import type { RunForm } from "../../src/web/run-form.ts";
import type { WebActionView } from "../../src/web/web-action-view.ts";
import type { WebActionRecord } from "../../src/web/web-action.ts";
import { writeRunningRun } from "../coordinator/running-run.ts";
import { pausedRun } from "../coordinator/run-log-fixtures.ts";
import { PORT, TOKEN, repoWithRuns, request, temp } from "./web-helpers.ts";

afterEach(() => temp.removeAll());

const ORIGIN = `http://127.0.0.1:${PORT}`;
const COOKIE = `factory-token=${TOKEN}`;

function post(repoDir: string, path: string, body: object, headers: { origin?: string | undefined; cookie?: string | undefined } = {}) {
  return handleRequest(
    request(repoDir, path, {
      method: "POST",
      body: JSON.stringify(body),
      origin: "origin" in headers ? headers.origin : ORIGIN,
      cookie: "cookie" in headers ? headers.cookie : COOKIE,
    }),
  );
}

function bodyOf<T>(response: WebResponse): T {
  return JSON.parse(String(response.body)) as T;
}

async function actionOnDisk(repoDir: string, record: Partial<WebActionRecord> & { id: string }, end?: object, output?: string) {
  const dir = join(repoDir, ".factory", "web", record.id);
  await mkdir(dir, { recursive: true });
  const full: WebActionRecord = {
    version: 1,
    command: "run",
    args: ["run", "28"],
    issue: 28,
    startedAt: "2026-10-24T07:58:00.000Z",
    pid: process.pid,
    processStart: await processStartTime(process.pid),
    ...record,
  };
  await writeFile(join(dir, "action.json"), JSON.stringify(full));
  if (end !== undefined) await writeFile(join(dir, "end.json"), JSON.stringify(end));
  if (output !== undefined) await writeFile(join(dir, "output.log"), output);
  return full;
}

describe("only the developer starts a web action", () => {
  it.each([
    ["another Origin", { origin: "http://evil.example" }],
    ["no Origin", { origin: undefined }],
    ["no token", { cookie: undefined }],
    ["a false token", { cookie: "factory-token=guessed" }],
    ["the token of the server under another cookie name", { cookie: `other=${TOKEN}` }],
  ])("should answer 403 and start nothing to a POST with %s", async (_, headers) => {
    const dir = await temp.make("web-actions-");

    const response = await post(dir, "/api/actions", { command: "doctor" }, headers);

    expect(response.status).toBe(403);
    expect(response.start).toBeUndefined();
    expect(existsSync(join(dir, ".factory", "web"))).toBe(false);
  });

  it("should accept a POST with the Origin of localhost and the token of the cookie, and return the web action as data without starting it", async () => {
    const dir = await temp.make("web-actions-");

    const response = await post(dir, "/api/actions", { command: "validate", issue: 28 }, { origin: `http://localhost:${PORT}` });

    expect(response.status).toBe(202);
    const id = bodyOf<{ id: string }>(response).id;
    expect(response.start).toEqual({ id, command: "validate", args: ["validate", "28"], issue: 28 });
    expect(id).toBe("2026-10-24T08-00-00-000Z-validate-28");
    expect(existsSync(join(dir, ".factory", "web"))).toBe(false);
  });

  it("should keep the token of the URL in an HttpOnly, SameSite=Strict cookie on the first visit and send the browser to the URL without it", async () => {
    const dir = await temp.make("web-actions-");

    const response = await handleRequest(request(dir, "/", { query: `token=${TOKEN}` }));

    expect(response.status).toBe(303);
    expect(response.headers?.location).toBe("/");
    expect(response.headers?.["set-cookie"]).toBe(`factory-token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`);
  });

  it("should set no cookie for a false token in the URL", async () => {
    const dir = await temp.make("web-actions-");

    const response = await handleRequest(request(dir, "/", { query: "token=guessed" }));

    expect(response.status).toBe(200);
    expect(response.headers?.["set-cookie"]).toBeUndefined();
  });

  it("should never start anything on a GET, even with the Origin and the token, so a link or a prefetch cannot start a command", async () => {
    const dir = await temp.make("web-actions-");

    for (const path of ["/api/actions", "/api/actions/2026-10-24T08-00-00-000Z-run-28/stop", "/api/run-form/28", "/"]) {
      const response = await handleRequest(request(dir, path, { origin: ORIGIN, cookie: COOKIE, body: JSON.stringify({ command: "doctor" }) }));
      expect(response.start).toBeUndefined();
      expect(response.stop).toBeUndefined();
    }
  });

  it("should refuse a command that is not a web action, with the reason", async () => {
    const dir = await temp.make("web-actions-");

    const response = await post(dir, "/api/actions", { command: "web" });

    expect(response.status).toBe(400);
    expect(bodyOf<{ error: string }>(response).error).toContain("web is not a web action");
    expect(response.start).toBeUndefined();
  });
});

describe("the arguments of each web action", () => {
  it.each([
    [{ command: "approve", issue: 7 }, ["approve", "7"]],
    [{ command: "publish", issue: 7 }, ["publish", "7"]],
    [{ command: "doctor" }, ["doctor"]],
    [{ command: "image" }, ["image"]],
    [{ command: "init" }, ["init"]],
  ])("should start %j as factory %j", async (body, args) => {
    const dir = await temp.make("web-actions-");

    expect((await post(dir, "/api/actions", body)).start?.args).toEqual(args);
  });

  it("should give the run form the same flags as the role menu of the CLI for the same choice", async () => {
    const dir = await temp.make("web-actions-");
    const roles = {
      workers: { agent: "claude-code", model: "opus" },
      verifier: { agent: "opencode", model: "opencode-go/glm-5.3" },
      tester: { agent: "claude-code", model: "sonnet" },
    } as const;

    const args = (await post(dir, "/api/actions", { command: "run", issue: 28, roles })).start?.args ?? [];

    expect(args).toEqual([
      "run",
      "28",
      "--worker-agent",
      "claude-code:opus",
      "--verifier-agent",
      "opencode:opencode-go/glm-5.3",
      "--tester-agent",
      "claude-code:sonnet",
    ]);
    for (const role of ["workers", "verifier", "tester"] as const) {
      const value = args[args.indexOf(ROLE_FLAGS[role]) + 1] ?? "";
      expect(parseRoleFlag(role, value)).toEqual({ ok: true, choice: roles[role] });
    }
  });

  it("should refuse an OpenCode model outside opencode-go/, as the CLI does, before it starts anything", async () => {
    const dir = await temp.make("web-actions-");

    const response = await post(dir, "/api/actions", { command: "run", issue: 28, roles: { workers: { agent: "opencode", model: "anthropic/claude" } } });

    expect(response.status).toBe(400);
    expect(bodyOf<{ error: string }>(response).error).toContain("opencode-go/");
    expect(response.start).toBeUndefined();
  });

  it("should refuse an issue that is not a positive integer", async () => {
    const dir = await temp.make("web-actions-");

    expect((await post(dir, "/api/actions", { command: "run", issue: "28 --force" })).status).toBe(400);
  });
});

describe("one web action at a time per issue", () => {
  it.each(["run", "approve", "publish"])("should refuse %s of an issue while a run of it started from the web is still working, with the reason", async (command) => {
    const dir = await temp.make("web-actions-");
    const busy = await actionOnDisk(dir, { id: "2026-10-24T07-58-00-000Z-run-28" });

    const response = await post(dir, "/api/actions", { command, issue: 28 });

    expect(response.status).toBe(409);
    expect(bodyOf<{ error: string }>(response).error).toContain(`factory run 28 (${busy.id}) is still working`);
    expect(response.start).toBeUndefined();
  });

  it("should accept a run of another issue, and a validate of the same one, which changes nothing", async () => {
    const dir = await temp.make("web-actions-");
    await actionOnDisk(dir, { id: "2026-10-24T07-58-00-000Z-run-28" });

    expect((await post(dir, "/api/actions", { command: "run", issue: 29 })).status).toBe(202);
    expect((await post(dir, "/api/actions", { command: "validate", issue: 28 })).status).toBe(202);
  });

  it("should accept a run of an issue whose earlier web action is interrupted", async () => {
    const dir = await temp.make("web-actions-");
    await actionOnDisk(dir, { id: "2026-10-24T07-58-00-000Z-run-28", processStart: "Thu Jan  1 00:00:00 1970" });

    expect((await post(dir, "/api/actions", { command: "run", issue: 28 })).status).toBe(202);
  });

  it("should refuse a run while the last run of the issue is in progress from a terminal, with the reason of the CLI", async () => {
    const dir = await temp.make("web-actions-");
    const at = new Date("2026-10-24T07:58:00.000Z");
    const run = await writeRunningRun({ logsDir: join(dir, ".factory", "logs"), issue: 28, runJsonAt: at, logAt: at });

    const response = await post(dir, "/api/actions", { command: "run", issue: 28 });

    expect(response.status).toBe(409);
    expect(bodyOf<{ error: string }>(response).error).toContain(`run ${run.runId} of #28 is in progress since`);
  });
});

describe("the web actions of the API", () => {
  it("should give a web action with its command, its state and its output", async () => {
    const dir = await temp.make("web-actions-");
    const id = "2026-10-24T07-58-00-000Z-validate-28";
    await actionOnDisk(dir, { id, command: "validate", args: ["validate", "28"] }, { exitCode: 1, endedAt: "2026-10-24T07:58:02.000Z" }, "specs/28.md is invalid\n");

    const response = await handleRequest(request(dir, `/api/actions/${id}`));

    expect(response.status).toBe(200);
    expect(bodyOf<WebActionView>(response)).toMatchObject({
      id,
      command: "factory validate 28",
      issue: 28,
      state: { kind: "ended", exitCode: 1 },
      output: "specs/28.md is invalid\n",
      inProgress: false,
    });
  });

  it("should show a web action with no end whose process is gone as interrupted, with no Stop", async () => {
    const dir = await temp.make("web-actions-");
    const id = "2026-10-24T07-58-00-000Z-run-28";
    await actionOnDisk(dir, { id, processStart: "Thu Jan  1 00:00:00 1970" });

    const view = bodyOf<WebActionView>(await handleRequest(request(dir, `/api/actions/${id}`)));

    expect(view.state).toEqual({ kind: "interrupted" });
    expect(view.canStop).toBe(false);
    expect((await post(dir, `/api/actions/${id}/stop`, {})).status).toBe(409);
  });

  it("should list the web actions from the most recent, so the board and the run page show the last one of an issue", async () => {
    const dir = await temp.make("web-actions-");
    await actionOnDisk(dir, { id: "2026-10-24T07-50-00-000Z-doctor", command: "doctor", args: ["doctor"], issue: null }, { exitCode: 0, endedAt: "x" });
    await actionOnDisk(dir, { id: "2026-10-24T07-58-00-000Z-run-28" });

    const list = bodyOf<{ actions: WebActionView[]; inProgress: boolean }>(await handleRequest(request(dir, "/api/actions")));

    expect(list.actions.map((action) => [action.id, action.state.kind])).toEqual([
      ["2026-10-24T07-58-00-000Z-run-28", "running"],
      ["2026-10-24T07-50-00-000Z-doctor", "ended"],
    ]);
    expect(list.inProgress).toBe(true);
  });

  it("should return the Stop of a running web action as data, with the process group and its start time, and signal nothing itself", async () => {
    const dir = await temp.make("web-actions-");
    const id = "2026-10-24T07-58-00-000Z-run-28";
    const record = await actionOnDisk(dir, { id });

    const response = await post(dir, `/api/actions/${id}/stop`, {});

    expect(response.status).toBe(202);
    expect(response.stop).toEqual({ pid: record.pid, processStart: record.processStart });
  });

  it("should answer 404 for a web action that does not exist or an ID out of format", async () => {
    const dir = await temp.make("web-actions-");

    expect((await handleRequest(request(dir, "/api/actions/2026-10-24T07-58-00-000Z-run-28"))).status).toBe(404);
    expect((await handleRequest(request(dir, "/api/actions/..%2F..%2Fetc"))).status).toBe(404);
  });
});

describe("the run form of the API", () => {
  it("should preselect each role from the paused run, with the warning of the plan limit the CLI menu gives", async () => {
    const log = { ...pausedRun(0), issue: 28, resetsAt: "2026-10-24T14:00:00.000Z", runId: "28-2026-10-10T08-00-00-000Z" };
    const dir = await repoWithRuns([{ log }]);

    const form = bodyOf<RunForm>(await handleRequest(request(dir, "/api/run-form/28")));

    const workers = form.roles.find((role) => role.role === "workers");
    expect(workers?.choice).toEqual({ agent: "claude-code", model: "m" });
    expect(workers?.origin).toBe("paused run");
    expect(workers?.warning).toMatch(/^⚠ claude-code plan limit until \d\d:\d\d: the run will pause again$/);
    expect(form.roles.map((role) => role.flag)).toEqual(["--worker-agent", "--verifier-agent", "--tester-agent"]);
  });

  it("should say why it cannot preselect the roles when the target repo has no config", async () => {
    const dir = await temp.make("web-actions-");

    const form = bodyOf<RunForm>(await handleRequest(request(dir, "/api/run-form/28")));

    expect(form.problem).toContain(".factory/config.ts");
    expect(form.roles.every((role) => role.choice === null)).toBe(true);
  });
});
