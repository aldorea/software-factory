// @vitest-environment jsdom
import { appendFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { ApiOrigin, POLL_MS } from "../../../src/web/client/app/api.ts";
import { App } from "../../../src/web/client/app/app.tsx";
import { startWebServer, type WebServer } from "../../../src/web/server.ts";
import { FakeClock } from "../../fakes/clock.ts";
import { realLog, writeLiveRun, type LiveRunFixture } from "../live-fixtures.ts";
import { CLIENT_DIR, NOW, temp } from "../web-helpers.ts";

const MINUTE = 60_000;
const servers: WebServer[] = [];

afterEach(async () => {
  cleanup();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await temp.removeAll();
});

async function serve(repoDir: string, port = 0): Promise<WebServer> {
  const server = await startWebServer({ repoDir, clientDir: CLIENT_DIR, port, clock: new FakeClock(NOW.toISOString()), err: () => {} });
  servers.push(server);
  return server;
}

interface Opened {
  dir: string;
  server: WebServer;
  runIds: string[];
}

async function open(runs: LiveRunFixture[], path = "/live"): Promise<Opened> {
  const dir = await temp.make("client-live-");
  const runIds: string[] = [];
  for (const run of runs) runIds.push((await writeLiveRun(join(dir, ".factory", "logs"), run)).runId);
  const server = await serve(dir);
  render(
    <ApiOrigin.Provider value={`http://${server.host}:${server.port}`}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </ApiOrigin.Provider>,
  );
  return { dir, server, runIds };
}

function text(element: HTMLElement): string {
  return (element.textContent ?? "").replace(/\s+/g, " ");
}

async function claudeLines(count: number): Promise<string[]> {
  return (await realLog("claude-activity.jsonl")).slice(0, count);
}

describe("the Live page", () => {
  it("should show one card per worker at work, grouped by run with its issue, title and step, the most recent run first", async () => {
    const lines = await claudeLines(6);
    await open([
      { issue: 21, startedAgoMs: 60 * MINUTE, integrationBranch: "factory/21-csv-export", attempts: [{ subtask: "a", lines }] },
      { issue: 24, startedAgoMs: 30 * MINUTE, attempts: [{ subtask: "d", lines }, { subtask: "e", lines }] },
    ]);

    const runs = await screen.findAllByRole("region", { name: /^Run #/ });

    expect(runs.map((run) => within(run).getByRole("heading").textContent)).toEqual(["#24 health endpoint", "#21 csv export"]);
    expect(text(runs[0] as HTMLElement)).toContain("Subtareas · d, e");
    expect(within(runs[0] as HTMLElement).getAllByRole("article").map((card) => card.getAttribute("aria-label"))).toEqual([
      "Worker d · attempt 1",
      "Worker e · attempt 1",
    ]);
    expect(within(runs[1] as HTMLElement).getAllByRole("article")).toHaveLength(1);
  });

  it("should show on a card the role, the agent, the model, the subtask, the step, the state, the last tool and message, the time, the attempt, the tokens and the silence with the time left", async () => {
    await open([{ attempts: [{ subtask: "health", number: 2, lines: await claudeLines(6), startedAgoMs: 5 * MINUTE, silentMs: 4 * MINUTE }] }]);

    const card = text(await screen.findByRole("article", { name: "Worker health · attempt 2" }));

    expect(card).toContain("Worker");
    expect(card).toContain("claude-code · claude-sonnet-5-5");
    expect(card).toContain("Subtask health · working");
    expect(card).toContain("silent");
    expect(card).toContain("Bash git status --short && find apps/nextjs/src/app/api/health -type f | xargs tail -n +1 && cat apps/ne…");
    expect(card).toContain("All checks pass. Next I'll commit.");
    expect(card).toContain("Tiempo 5 min");
    expect(card).toContain("Attempt 2");
    expect(card).toContain("Tokens 13103 in · 98 out");
    expect(card).toContain("Sin actividad 4 min · abandonado en 6 min");
  });

  it("should show a card for a question of the independent verifier with its criterion and its last message once, in the line of the tool, and one for the acceptance tester with its phase", async () => {
    await open([
      {
        attempts: [{ subtask: "health", outcome: "completed" }],
        verifierQuestions: [{ subtask: "health", criterion: "C2", lines: await realLog("opencode-run.jsonl") }],
        tester: { phase: "install" },
      },
    ]);

    const verifier = await screen.findByRole("article", { name: "Independent verifier C2 · attempt 1" });
    const tester = screen.getByRole("article", { name: "Acceptance tester · attempt 1" });

    expect(text(verifier)).toContain("Criterion C2 · Subtask health");
    expect(within(verifier).getAllByText("OK")).toHaveLength(1);
    expect(text(tester)).toContain("install");
    expect(text(tester)).toContain("Tokens —");
  });

  it("should fold the acceptance tester that ended into a row with its verdict", async () => {
    await open([{ attempts: [{ subtask: "health", outcome: "completed" }], tester: { verdicts: [{ id: "C1", passed: false }], durationMs: 2 * MINUTE } }]);

    const rows = within(await screen.findByRole("list", { name: "Agentes que terminaron" })).getAllByRole("listitem").map(text);

    expect(rows).toContainEqual(expect.stringMatching(/^Acceptance tester · attempt 1opencode · opencode-go\/glm-5\.1failed2 min/));
  });

  it("should draw the text of a raw log as text, never as HTML", async () => {
    const message = JSON.stringify({ type: "text", timestamp: 1793178670818, part: { type: "text", text: "<img src=x onerror=alert(1)>" } });
    await open([{ attempts: [{ subtask: "x", agent: "opencode", lines: [message] }] }]);

    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeDefined();
    expect(document.querySelector("img")).toBeNull();
  });

  it("should fold a worker that ended into one row with its outcome, under the cards of its run", async () => {
    await open([
      {
        attempts: [
          { subtask: "health", number: 1, agent: "opencode", model: "opencode-go/glm-5.1", outcome: "agent-error", durationMs: MINUTE, usage: { inputTokens: 1000, outputTokens: 40 } },
          { subtask: "health", number: 2, lines: await claudeLines(6) },
        ],
      },
    ]);

    const run = await screen.findByRole("region", { name: /^Run #/ });
    await within(run).findByRole("article");

    expect(within(run).getAllByRole("article")).toHaveLength(1);
    expect(within(within(run).getByRole("list", { name: "Agentes que terminaron" })).getAllByRole("listitem").map(text)).toEqual([
      "Worker health · attempt 1opencode · opencode-go/glm-5.1agent-error1 min · 1000 in · 40 out",
    ]);
  });

  it("should say that no agent works and link to Runs when no run is in progress", async () => {
    await open([]);

    expect(await screen.findByText("Ningún agente trabaja ahora.")).toBeDefined();
    expect(screen.getByRole("link", { name: "Ver los runs" }).getAttribute("href")).toBe("/");
  });

  it("should say that no agent works and link to Runs when the runs in progress have only agents that ended", async () => {
    await open([{ attempts: [{ subtask: "health", outcome: "completed" }] }]);

    expect(await screen.findByText("Ningún agente trabaja ahora.")).toBeDefined();
    expect(screen.getByRole("link", { name: "Ver los runs" }).getAttribute("href")).toBe("/");
  });

  it("should say that no agent works when a run in progress has no agent yet", async () => {
    await open([{ attempts: [] }]);

    expect(await screen.findByText("Ningún agente trabaja ahora.")).toBeDefined();
  });

  it("should not say that no agent works while one works", async () => {
    await open([{ attempts: [{ subtask: "health", lines: await claudeLines(6) }] }]);
    await screen.findByRole("article");

    expect(screen.queryByText("Ningún agente trabaja ahora.")).toBeNull();
  });

  it("should say on a card that an abandoned agent is abandoned, with no time left", async () => {
    const lines = await claudeLines(6);
    await open([{ attemptIdleTimeoutMs: 3 * MINUTE, attempts: [{ subtask: "a", lines, silentMs: 4 * MINUTE }, { subtask: "b", lines }] }]);

    const card = text(await screen.findByRole("article", { name: "Worker a · attempt 1" }));

    expect(card).toContain("Sin actividad 4 min · abandonado");
    expect(card).not.toContain("abandonado en");
  });

  it("should show a live indicator next to Live in the menu while the page refreshes, on any page", async () => {
    await open([{ attempts: [{ subtask: "a", lines: await claudeLines(6) }] }], "/settings");

    const live = within(screen.getByRole("navigation", { name: "Menú" })).getByRole("link", { name: /^Live/ });

    expect(await within(live).findByRole("img", { name: "Actualizando en directo" })).toBeDefined();
  });

  it("should show no live indicator when no agent works, since the page no longer refreshes", async () => {
    await open([{ attempts: [{ subtask: "a", outcome: "completed" }] }]);
    await screen.findByText("Ningún agente trabaja ahora.");

    expect(screen.queryByRole("img", { name: "Actualizando en directo" })).toBeNull();
  });

  it("should show the count of agents at work next to Live in the menu, on any page", async () => {
    const lines = await claudeLines(6);
    await open([{ attempts: [{ subtask: "a", lines }, { subtask: "b", lines, silentMs: 3 * MINUTE }, { subtask: "c", outcome: "completed" }] }], "/settings");

    const live = within(screen.getByRole("navigation", { name: "Menú" })).getByRole("link", { name: /^Live/ });

    await waitFor(() => expect(text(live)).toBe("Live2"));
  });

  it(
    "should ask again every 2 seconds while an agent works, and draw its new activity",
    async () => {
      const lines = await realLog("claude-activity.jsonl");
      const { dir, runIds } = await open([{ attempts: [{ subtask: "health", lines: lines.slice(0, 5) }] }]);
      await screen.findByText("The files already exist. Next I'll check whether the middleware or auth blocks the route, then run …", { selector: "[role=article] *" });

      const rawLog = join(dir, ".factory", "logs", runIds[0] as string, "health-attempt-1.jsonl");
      await appendFile(rawLog, `${lines[5]}\n`);
      await utimes(rawLog, NOW, NOW);

      expect(await screen.findByText("All checks pass. Next I'll commit.", { selector: "[role=article] *" }, { timeout: 2 * POLL_MS + 1000 })).toBeDefined();
    },
    4 * POLL_MS,
  );

  it(
    "should stop asking once no agent works",
    async () => {
      const { dir } = await open([{ attempts: [{ subtask: "health", outcome: "completed" }] }]);
      await screen.findByRole("list", { name: "Agentes que terminaron" });

      await writeLiveRun(join(dir, ".factory", "logs"), { issue: 99, attempts: [{ subtask: "late", lines: await claudeLines(6) }] });
      await new Promise((resolve) => setTimeout(resolve, POLL_MS + 500));

      expect(screen.queryByRole("article")).toBeNull();
    },
    4 * POLL_MS,
  );

  it(
    "should keep the last data with a notice when a refresh fails, and try again",
    async () => {
      const { dir, server } = await open([{ attempts: [{ subtask: "health", lines: await claudeLines(6), silentMs: 0 }] }]);
      await screen.findByRole("article");
      const port = server.port;

      await server.close();
      await screen.findByText("Sin conexión con factory web; se vuelve a intentar cada 2 s.", {}, { timeout: 2 * POLL_MS });
      expect(screen.getByRole("article", { name: "Worker health · attempt 1" })).toBeDefined();

      await serve(dir, port);
      await waitFor(() => expect(screen.queryByText("Sin conexión con factory web; se vuelve a intentar cada 2 s.")).toBeNull(), { timeout: 2 * POLL_MS });
    },
    6 * POLL_MS,
  );
});
