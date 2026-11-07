// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { RunLog } from "../../../src/coordinator/run-log.ts";
import { ApiOrigin } from "../../../src/web/client/app/api.ts";
import { App } from "../../../src/web/client/app/app.tsx";
import { startWebServer, type WebServer } from "../../../src/web/server.ts";
import { cleanRun, failedRun, pausedRun } from "../../coordinator/run-log-fixtures.ts";
import { FakeClock } from "../../fakes/clock.ts";
import { CLIENT_DIR, NOW, aRun, repoWithRuns, temp } from "../web-helpers.ts";

const servers: WebServer[] = [];

afterEach(async () => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await temp.removeAll();
});

async function serve(repoDir: string): Promise<string> {
  const server = await startWebServer({ repoDir, clientDir: CLIENT_DIR, port: 0, clock: new FakeClock(NOW.toISOString()), err: () => {} });
  servers.push(server);
  return `http://${server.host}:${server.port}`;
}

async function open(runs: Array<{ log: RunLog; modifiedAt?: Date }>, path = "/"): Promise<void> {
  const origin = await serve(runs.length === 0 ? await temp.make("client-empty-") : await repoWithRuns(runs));
  render(
    <ApiOrigin.Provider value={origin}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </ApiOrigin.Provider>,
  );
}

function text(element: HTMLElement): string {
  return (element.textContent ?? "").replace(/\s+/g, " ");
}

async function section(name: string): Promise<string> {
  return text(await screen.findByRole("region", { name }));
}

describe("the home page of the client", () => {
  it("should list the runs from the most recent to the oldest with issue, run ID, result, age and pull request", async () => {
    const oldest = { ...aRun(0), issue: 11, pullRequest: { number: 5, url: "https://github.com/acme/app/pull/5", draft: false } };
    const newest = { ...aRun(1, { result: "draft" }), issue: 12 };
    await open([{ log: oldest, modifiedAt: new Date(NOW.getTime() - 3 * 3_600_000) }, { log: newest }]);

    const rows = within(await screen.findByRole("table", { name: "Lista de runs" })).getAllByRole("row").slice(1);

    expect(rows.map(text)).toEqual([
      `#12${newest.runId}drafthace un momento—`,
      `#11${oldest.runId}readyhace 3 h#5`,
    ]);
    expect(screen.getByRole("link", { name: "#5" }).getAttribute("href")).toBe("https://github.com/acme/app/pull/5");
    expect(screen.getByRole("link", { name: newest.runId }).getAttribute("href")).toBe(`/runs/${newest.runId}`);
  });

  it("should draw the text of run.json as text, never as HTML", async () => {
    await open([{ log: { ...cleanRun(0), runId: "<img src=x onerror=alert(1)>" } }]);

    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeDefined();
    expect(document.querySelector("img")).toBeNull();
  });

  it("should list apart the run.json files that cannot be read", async () => {
    await open([{ log: cleanRun(0) }, { log: { ...cleanRun(1), version: 0 as 1 } }]);

    expect(await section("run.json ilegibles")).toContain("1-run-01/run.json");
  });

  it("should show an empty page with no statistics for a repo without a run log, not an error", async () => {
    await open([]);

    expect(await screen.findByText("Todavía no hay runs: .factory/logs no tiene ficheros run.json.")).toBeDefined();
    expect(screen.queryByRole("region", { name: "Estadísticas" })).toBeNull();
  });

  it("should show not published in place of the pull request of a run whose publication failed", async () => {
    const failure = { phase: "integration-push" as const, message: "timeout", at: "2026-10-24T07:30:00.000Z" };
    await open([{ log: aRun(0, { publicationFailure: failure }) }]);

    expect(await screen.findByText("not published")).toBeDefined();
  });
});

describe("the statistics of the home page", () => {
  it("should count the runs of each result", async () => {
    await open([{ log: cleanRun(0) }, { log: cleanRun(1) }, { log: { ...failedRun(2), result: "draft" } }, { log: pausedRun(3) }]);

    expect(await section("Resultados")).toContain("Runs4Ready2Draft1Paused1Running0Abandoned0Sin publicar0");
  });

  it("should add up the passing, blocked, human and pending criteria of all the runs, as factory stats does", async () => {
    await open([
      { log: { ...cleanRun(0), criteria: { passing: ["AC1", "AC2"], blocked: ["AC3"], human: [], pending: ["AC4"] } } },
      { log: { ...cleanRun(1), criteria: { passing: ["AC1"], blocked: [], human: ["AC5", "AC6"], pending: [] } } },
    ]);

    expect(await section("Criterios")).toContain("Pasan3Bloqueados1Human2Pendientes1");
  });

  it("should show the runs, attempts, tokens and pauses of each agent so the subscriptions can be compared", async () => {
    await open([{ log: cleanRun(0, "claude-code") }, { log: cleanRun(1, "opencode") }, { log: cleanRun(2, "opencode") }, { log: pausedRun(3, "opencode", "opencode") }]);

    const agents = await screen.findByRole("region", { name: "Por agente" });

    expect(within(agents).getAllByRole("row").map(text)).toEqual(["AgenteRunsAttemptsTokensPausas", "claude-code111500", "opencode323001"]);
  });

  it("should show the total and the average of attempts, tokens and wall clock without pauses, and the time paused", async () => {
    const paused = cleanRun(0);
    await open([{ log: { ...paused, cost: { ...paused.cost, pausedMs: 90 * 60_000 } } }, { log: cleanRun(1) }, { log: failedRun(2) }]);

    const cost = await section("Coste");

    expect(cost).toContain("Tokens450 (150 por run, 150 por subtask, como máximo 150 en un subtask)");
    expect(cost).toContain("Attempts3 (1.0 por run, 1.0 por subtask)");
    expect(cost).toContain("Wall clock sin pausas3 min (1 min por run)");
    expect(cost).toContain("Pausa1 h 30 min");
  });

  it("should show the blocks by type, the rejections and the conflicts, and say there are none", async () => {
    const first = cleanRun(0);
    const friction = { ...first.friction, blocks: { ...first.friction.blocks, scope: 3, patience: 1 }, scopeExtensions: 3, gateRejections: 4 };
    await open([{ log: { ...first, friction } }]);

    const text = await section("Fricción");

    expect(text).toContain("Bloqueosscope 3, patience 1");
    expect(text).toContain("Scope extensions3");
    expect(text).toContain("Rechazos del gate4");
    expect(await section("Worker layer")).toContain("Fallos de la worker layerninguno");
  });

  it("should count the failures of the worker layer by kind", async () => {
    const failure = failedRun(1).workerLayerFailures[0] as RunLog["workerLayerFailures"][number];
    await open([{ log: failedRun(0) }, { log: { ...failedRun(1), workerLayerFailures: [failure, { ...failure, kind: "process-hang" }] } }]);

    expect(await section("Worker layer")).toContain("Fallos de la worker layercontainer-start 2, process-hang 1");
  });
});

describe("the shell of the client", () => {
  it("should have a side menu with Live, Board, Runs and Settings, and no page of web actions, which open in a panel", async () => {
    await open([]);

    const menu = screen.getByRole("navigation", { name: "Menú" });

    expect(within(menu).getAllByRole("link").map(text)).toEqual(["Live", "Board", "Runs", "Settings"]);
  });

  it("should move between pages with the menu, and say that a page does not exist yet", async () => {
    await open([]);

    fireEvent.click(screen.getByRole("link", { name: "Board" }));

    expect(await screen.findByRole("heading", { name: "Board" })).toBeDefined();
    expect(screen.getByText("Esta página todavía no existe.")).toBeDefined();
  });

  it("should show a not found page for a path that is no page", async () => {
    await open([], "/nope");

    expect(await screen.findByRole("heading", { name: "Página no encontrada" })).toBeDefined();
  });

  it("should be light by default and switch to dark with the toggle", async () => {
    await open([]);

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Tema oscuro" }));

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(screen.getByRole("button", { name: "Tema claro" })).toBeDefined();
  });
});
