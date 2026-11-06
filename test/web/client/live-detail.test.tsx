// @vitest-environment jsdom
import { appendFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
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

function Where() {
  return <output aria-label="URL">{useLocation().search}</output>;
}

interface Opened {
  dir: string;
  origin: string;
  runIds: string[];
}

async function serve(runs: LiveRunFixture[]): Promise<Opened> {
  const dir = await temp.make("client-live-detail-");
  const runIds: string[] = [];
  for (const run of runs) runIds.push((await writeLiveRun(join(dir, ".factory", "logs"), run)).runId);
  const server = await startWebServer({ repoDir: dir, clientDir: CLIENT_DIR, port: 0, clock: new FakeClock(NOW.toISOString()), err: () => {} });
  servers.push(server);
  return { dir, origin: `http://${server.host}:${server.port}`, runIds };
}

function show(origin: string, path: string): void {
  render(
    <ApiOrigin.Provider value={origin}>
      <MemoryRouter initialEntries={[path]}>
        <App />
        <Where />
      </MemoryRouter>
    </ApiOrigin.Provider>,
  );
}

function text(element: HTMLElement): string {
  return (element.textContent ?? "").replace(/\s+/g, " ");
}

function search(): string {
  return screen.getByRole("status", { name: "URL" }).textContent ?? "";
}

describe("the detail of an agent on Live", () => {
  it("should open the detail of the agent named in ?agent=, with its run and role, step and state, agent, model and attempt, its numbers and its silence towards the threshold of abandonment", async () => {
    const lines = (await realLog("claude-activity.jsonl")).slice(0, 6);
    const { origin, runIds } = await serve([{ issue: 23, attempts: [{ subtask: "health", number: 2, lines, startedAgoMs: 5 * MINUTE, silentMs: 4 * MINUTE }] }]);
    const id = `${runIds[0]}:worker:health:2`;

    show(origin, `/live?agent=${encodeURIComponent(id)}`);
    const detail = await screen.findByRole("complementary", { name: "Detalle del agente" });

    expect(text(detail)).toContain("#23 health endpoint › Worker health");
    expect(within(detail).getByRole("heading").textContent).toBe("working");
    expect(text(detail)).toContain("silent");
    expect(text(detail)).toContain("claude-code · claude-sonnet-5-5 · attempt 2");
    expect(text(detail)).toContain("Tiempo5 min");
    expect(text(detail)).toContain("Tokens entrada13103");
    expect(text(detail)).toContain("Tokens salida98");
    expect(text(detail)).toContain("Silencio4 min");
    const bar = within(detail).getByRole("meter", { name: "Silencio hacia el abandono" });
    expect([bar.getAttribute("aria-valuenow"), bar.getAttribute("aria-valuemax")]).toEqual([String(4 * MINUTE), String(10 * MINUTE)]);
    expect(text(detail)).toContain("abandonado en 6 min");
  });

  it("should list the last events of the agent, the most recent first, each with its time", async () => {
    const lines = (await realLog("claude-activity.jsonl")).slice(0, 6);
    const { origin, runIds } = await serve([{ attempts: [{ subtask: "health", lines }] }]);

    show(origin, `/live?agent=${encodeURIComponent(`${runIds[0]}:worker:health:1`)}`);
    const events = await screen.findByRole("list", { name: "Últimos eventos" });

    expect(
      within(events)
        .getAllByRole("listitem")
        .map((item) => [item.querySelector("time")?.getAttribute("datetime"), text(item).replace(/^\S+ /, "")]),
    ).toEqual([
      ["2026-10-27T07:27:44.315Z", "All checks pass. Next I'll commit."],
      ["2026-10-27T07:26:02.877Z", "The files already exist. Next I'll check whether the middleware or auth blocks the route, then run …"],
      ["2026-10-27T07:26:01.312Z", "Bash git status --short && find apps/nextjs/src/app/api/health -type f | xargs tail -n +1 && cat apps/ne…"],
    ]);
  });

  it("should open the detail on a click on a card, put the agent in the URL and drop the cards to one column, and close it on a second click", async () => {
    const lines = (await realLog("claude-activity.jsonl")).slice(0, 6);
    const { origin, runIds } = await serve([{ attempts: [{ subtask: "a", lines }, { subtask: "b", lines }] }]);
    show(origin, "/live");
    const card = await screen.findByRole("article", { name: "Worker b · attempt 1" });

    fireEvent.click(card);

    const detail = await screen.findByRole("complementary", { name: "Detalle del agente" });
    expect(text(detail)).toContain("› Worker b");
    expect(new URLSearchParams(search()).get("agent")).toBe(`${runIds[0]}:worker:b:1`);
    expect(card.parentElement?.className).toContain("grid-cols-1");
    expect(card.parentElement?.className).not.toContain("md:grid-cols-2");

    fireEvent.click(card);

    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Detalle del agente" })).toBeNull());
    expect(search()).toBe("");
    expect(card.parentElement?.className).toContain("md:grid-cols-2");
  });

  it("should close the detail with its close button and remove the agent from the URL", async () => {
    const lines = (await realLog("claude-activity.jsonl")).slice(0, 6);
    const { origin, runIds } = await serve([{ attempts: [{ subtask: "a", lines }] }]);
    show(origin, `/live?agent=${encodeURIComponent(`${runIds[0]}:worker:a:1`)}`);
    const detail = await screen.findByRole("complementary", { name: "Detalle del agente" });

    fireEvent.click(within(detail).getByRole("button", { name: "Cerrar detalle" }));

    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Detalle del agente" })).toBeNull());
    expect(search()).toBe("");
  });

  it("should open the detail of an agent that ended from its row, with its outcome, its tokens and its last events", async () => {
    const lines = await realLog("claude-activity.jsonl");
    const { origin } = await serve([
      {
        attempts: [
          { subtask: "health", number: 1, outcome: "completed", lines, durationMs: 2 * MINUTE, usage: { inputTokens: 900, cacheCreationInputTokens: 100, outputTokens: 40 } },
          { subtask: "health", number: 2, lines: lines.slice(0, 6) },
        ],
      },
    ]);
    show(origin, "/live");
    const rows = await screen.findByRole("list", { name: "Agentes que terminaron" });

    fireEvent.click(within(rows).getByRole("listitem"));

    const detail = await screen.findByRole("complementary", { name: "Detalle del agente" });
    expect(text(detail)).toContain("completed");
    expect(text(detail)).toContain("attempt 1");
    expect(text(detail)).toContain("Tiempo2 min");
    expect(text(detail)).toContain("Tokens entrada1000");
    expect(text(detail)).toContain("Tokens salida40");
    expect(text(detail)).toContain("Silencio—");
    expect(within(detail).queryByRole("meter")).toBeNull();
    expect(within(within(detail).getByRole("list", { name: "Últimos eventos" })).getAllByRole("listitem").map(text)[0]).toContain("attempt ended");
  });

  it("should open Live with no detail when the agent of ?agent= is no longer known", async () => {
    const lines = (await realLog("claude-activity.jsonl")).slice(0, 6);
    const { origin } = await serve([{ attempts: [{ subtask: "a", lines }] }]);

    show(origin, "/live?agent=gone%3Aworker%3Aa%3A1");
    const card = await screen.findByRole("article");

    expect(screen.queryByRole("complementary", { name: "Detalle del agente" })).toBeNull();
    expect(card.parentElement?.className).toContain("md:grid-cols-2");
  });

  it("should keep the detail open on a reload of its URL", async () => {
    const lines = (await realLog("claude-activity.jsonl")).slice(0, 6);
    const { origin } = await serve([{ attempts: [{ subtask: "a", lines }] }]);
    show(origin, "/live");
    fireEvent.click(await screen.findByRole("article"));
    await screen.findByRole("complementary", { name: "Detalle del agente" });
    const url = `/live${search()}`;
    cleanup();

    show(origin, url);

    expect(text(await screen.findByRole("complementary", { name: "Detalle del agente" }))).toContain("› Worker a");
  });

  it(
    "should refresh the detail with the page and keep its scroll",
    async () => {
      const lines = await realLog("claude-activity.jsonl");
      const { dir, origin, runIds } = await serve([{ attempts: [{ subtask: "health", lines: lines.slice(0, 5) }] }]);
      show(origin, `/live?agent=${encodeURIComponent(`${runIds[0]}:worker:health:1`)}`);
      const events = await screen.findByRole("list", { name: "Últimos eventos" });
      const scroller = events.closest("aside")?.firstElementChild as HTMLElement;
      scroller.scrollTop = 120;

      const rawLog = join(dir, ".factory", "logs", runIds[0] as string, "health-attempt-1.jsonl");
      await appendFile(rawLog, `${lines[5]}\n`);
      await utimes(rawLog, NOW, NOW);

      await within(events).findByText("All checks pass. Next I'll commit.", {}, { timeout: 2 * POLL_MS + 1000 });
      expect(screen.getByRole("list", { name: "Últimos eventos" })).toBe(events);
      expect(scroller.scrollTop).toBe(120);
    },
    4 * POLL_MS,
  );
});
