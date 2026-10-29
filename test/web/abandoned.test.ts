import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleRequest } from "../../src/web/handler.ts";
import { writeRunningRun, type RunningRun } from "../coordinator/running-run.ts";
import { NOW, request, temp, visibleText } from "./web-helpers.ts";

afterEach(() => temp.removeAll());

const TIMEOUT = 10 * 60_000;
const RELOAD = "http-equiv";

function before(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

async function repoWith(runJsonSilentMs: number, logSilentMs: number): Promise<{ dir: string; run: RunningRun }> {
  const dir = await temp.make("web-abandoned-");
  const run = await writeRunningRun({
    logsDir: join(dir, ".factory", "logs"),
    runJsonAt: before(runJsonSilentMs),
    logAt: before(logSilentMs),
  });
  return { dir, run };
}

async function homeText(dir: string): Promise<string> {
  const response = await handleRequest(request(dir, "/", { idleTimeoutMs: TIMEOUT }));
  expect(response.status).toBe(200);
  return response.body;
}

async function runBody(dir: string, run: RunningRun): Promise<string> {
  const response = await handleRequest(request(dir, `/runs/${run.runId}`, { idleTimeoutMs: TIMEOUT }));
  expect(response.status).toBe(200);
  return response.body;
}

describe("an abandoned run in factory web", () => {
  it("should show abandoned and not running in the list of runs of the home page", async () => {
    const { dir } = await repoWith(TIMEOUT + 60_000, TIMEOUT + 60_000);

    const body = await homeText(dir);

    expect(body).toContain('<span class="badge warn">abandoned</span>');
    expect(body).not.toContain(">running<");
  });

  it("should count it apart from the running and the finished runs in the statistics of the home page", async () => {
    const { dir } = await repoWith(TIMEOUT + 60_000, TIMEOUT + 60_000);

    const text = visibleText(await homeText(dir));

    expect(text).toContain("Abandoned 1");
    expect(text).toContain("Running 0");
  });

  it("should show abandoned and not running in the page of the run, and in its attempt in progress", async () => {
    const { dir, run } = await repoWith(TIMEOUT + 60_000, TIMEOUT + 60_000);

    const body = await runBody(dir, run);

    expect(body).toContain("Resultado: <span class=\"badge warn\">abandoned</span>");
    expect(visibleText(body)).toContain("Resultado: abandoned");
    expect(visibleText(body)).not.toContain("running");
  });

  it("should not reload the home page nor the page of the run, which no process is changing", async () => {
    const { dir, run } = await repoWith(TIMEOUT + 60_000, TIMEOUT + 60_000);

    expect(await homeText(dir)).not.toContain(RELOAD);
    expect(await runBody(dir, run)).not.toContain(RELOAD);
  });
});

describe("a run in progress in factory web", () => {
  it("should show running while the raw log of its attempt keeps growing although run.json did not change", async () => {
    const { dir, run } = await repoWith(2 * 60 * 60_000, 30_000);

    const home = await homeText(dir);
    const page = await runBody(dir, run);

    expect(home).toContain('<span class="badge info">running</span>');
    expect(home).not.toContain("abandoned");
    expect(page).toContain("Resultado: <span class=\"badge info\">running</span>");
    expect(visibleText(page)).toContain("Resultado: running");
    expect(page).toContain(RELOAD);
  });

  it("should take attemptIdleTimeoutMs from the request so a longer limit keeps the run in progress", async () => {
    const { dir } = await repoWith(TIMEOUT + 60_000, TIMEOUT + 60_000);

    const response = await handleRequest(request(dir, "/", { idleTimeoutMs: 2 * TIMEOUT }));

    expect(response.body).toContain('<span class="badge info">running</span>');
  });
});
