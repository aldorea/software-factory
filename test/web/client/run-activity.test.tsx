// @vitest-environment jsdom
import { appendFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { writeRunLog } from "../../../src/coordinator/run-log.ts";
import { ApiOrigin, POLL_MS } from "../../../src/web/client/app/api.ts";
import { App } from "../../../src/web/client/app/app.tsx";
import { startWebServer, type WebServer } from "../../../src/web/server.ts";
import { FakeClock } from "../../fakes/clock.ts";
import { realLog, writeLiveRun, type LiveRun, type LiveRunFixture } from "../live-fixtures.ts";
import { CLIENT_DIR, NOW, temp } from "../web-helpers.ts";

const MINUTE = 60_000;
const servers: WebServer[] = [];

afterEach(async () => {
  cleanup();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await temp.removeAll();
});

async function write(runs: LiveRunFixture[]): Promise<{ dir: string; runs: LiveRun[] }> {
  const dir = await temp.make("client-run-activity-");
  const written: LiveRun[] = [];
  for (const run of runs) written.push(await writeLiveRun(join(dir, ".factory", "logs"), run));
  return { dir, runs: written };
}

async function open(dir: string, path: string): Promise<void> {
  const server = await startWebServer({ repoDir: dir, clientDir: CLIENT_DIR, port: 0, clock: new FakeClock(NOW.toISOString()), err: () => {} });
  servers.push(server);
  render(
    <ApiOrigin.Provider value={`http://${server.host}:${server.port}`}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </ApiOrigin.Provider>,
  );
  await screen.findByRole("heading", { level: 1, name: /#[0-9]+ / });
}

function text(element: Element): string {
  return (element.textContent ?? "").replace(/\s+/g, " ");
}

function panel(): HTMLElement {
  return screen.getByRole("tabpanel");
}

async function claudeLines(count: number): Promise<string[]> {
  return (await realLog("claude-activity.jsonl")).slice(0, count);
}

describe("the Activity tab of a run", () => {
  it("should show the cards of the agents of that run only, never those of another run in progress", async () => {
    const lines = await claudeLines(6);
    const { dir, runs } = await write([
      { issue: 23, startedAgoMs: 30 * MINUTE, attempts: [{ subtask: "health", lines }, { subtask: "metrics", lines }] },
      { issue: 24, startedAgoMs: 20 * MINUTE, attempts: [{ subtask: "auth", lines }] },
    ]);

    await open(dir, `/runs/${runs[0]?.runId}?tab=activity`);

    const cards = await within(panel()).findAllByRole("article");
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual(["Worker health · attempt 1", "Worker metrics · attempt 1"]);
    expect(text(cards[0] as HTMLElement)).toContain("All checks pass. Next I'll commit.");
    expect(within(panel()).queryByRole("region", { name: /^Run #24/ })).toBeNull();
  });

  it("should show the ended agents of a run that ended as rows with their outcome", async () => {
    const { dir, runs } = await write([
      {
        issue: 23,
        result: "ready",
        attempts: [
          { subtask: "health", number: 1, agent: "opencode", model: "opencode-go/glm-5.1", outcome: "agent-error", durationMs: MINUTE, usage: { inputTokens: 1000, outputTokens: 40 } },
          { subtask: "health", number: 2, outcome: "completed", durationMs: 2 * MINUTE, usage: { inputTokens: 500, outputTokens: 20 } },
        ],
      },
    ]);

    await open(dir, `/runs/${runs[0]?.runId}?tab=activity`);

    const rows = within(await within(panel()).findByRole("list", { name: "Agentes que terminaron" })).getAllByRole("listitem");
    expect(rows.map(text)).toEqual([
      "Worker health · attempt 1opencode · opencode-go/glm-5.1agent-error1 min · 1000 in · 40 out",
      "Worker health · attempt 2claude-code · claude-sonnet-5-5completed2 min · 500 in · 20 out",
    ]);
    expect(within(panel()).queryByRole("article")).toBeNull();
  });

  it(
    "should ask again every 2 seconds while an agent of the run works, and draw its new activity",
    async () => {
      const lines = await realLog("claude-activity.jsonl");
      const { dir, runs } = await write([{ attempts: [{ subtask: "health", lines: lines.slice(0, 5) }] }]);
      await open(dir, `/runs/${runs[0]?.runId}?tab=activity`);
      await within(panel()).findByRole("article");

      const rawLog = join(runs[0]?.runDir as string, "health-attempt-1.jsonl");
      await appendFile(rawLog, `${lines[5]}\n`);
      await utimes(rawLog, NOW, NOW);

      expect(await within(panel()).findByText("All checks pass. Next I'll commit.", { selector: "[role=article] *" }, { timeout: 2 * POLL_MS + 1000 })).toBeDefined();
    },
    4 * POLL_MS,
  );

  it("should open the detail of an ended agent beside its row with its last events, and stay on the Activity tab", async () => {
    const { dir, runs } = await write([{ issue: 23, result: "ready", attempts: [{ subtask: "health", outcome: "completed", lines: await claudeLines(6) }] }]);
    await open(dir, `/runs/${runs[0]?.runId}?tab=activity`);

    fireEvent.click(within(await within(panel()).findByRole("list", { name: "Agentes que terminaron" })).getByRole("listitem"));

    const detail = await within(panel()).findByRole("complementary", { name: "Detalle del agente" });
    expect(within(detail).getByRole("list", { name: "Últimos eventos" }).firstElementChild?.textContent).toContain("All checks pass. Next I'll commit.");
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Actividad");
  });

  it(
    "should ask again when run.json changes, so a run that waits between steps with no agent at work shows its next agent",
    async () => {
      const fixture: LiveRunFixture = { issue: 23, runJsonSilentMs: MINUTE, attempts: [{ subtask: "health", outcome: "completed" }] };
      const { dir, runs } = await write([fixture]);
      await open(dir, `/runs/${runs[0]?.runId}?tab=activity`);
      await within(panel()).findByRole("list", { name: "Agentes que terminaron" });

      await writeLiveRun(join(dir, ".factory", "logs"), {
        ...fixture,
        runJsonSilentMs: 0,
        attempts: [...fixture.attempts, { subtask: "metrics", lines: await claudeLines(6) }],
      });

      expect(await within(panel()).findByRole("article", { name: "Worker metrics · attempt 1" }, { timeout: 2 * POLL_MS + 1000 })).toBeDefined();
    },
    4 * POLL_MS,
  );
});

describe("the refresh of the Activity tab of a run", () => {
  it(
    "should keep the open detail when run.json changes, with no new Cargando…, since the tab is not drawn again from scratch",
    async () => {
      const lines = await claudeLines(6);
      const fixture: LiveRunFixture = { issue: 23, runJsonSilentMs: MINUTE, attempts: [{ subtask: "health", lines }] };
      const { dir, runs } = await write([fixture]);
      await open(dir, `/runs/${runs[0]?.runId}?tab=activity&agent=${encodeURIComponent(`${runs[0]?.runId}:worker:health:1`)}`);
      const detail = await within(panel()).findByRole("complementary", { name: "Detalle del agente" });
      let loading = false;
      const observer = new MutationObserver(() => {
        loading ||= (document.body.textContent ?? "").includes("Cargando…");
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });

      await writeLiveRun(join(dir, ".factory", "logs"), { ...fixture, runJsonSilentMs: 0, attempts: [...fixture.attempts, { subtask: "metrics", lines }] });
      await within(panel()).findByRole("article", { name: "Worker metrics · attempt 1" }, { timeout: 2 * POLL_MS + 1000 });
      observer.disconnect();

      expect(loading).toBe(false);
      expect(within(panel()).getByRole("complementary", { name: "Detalle del agente" })).toBe(detail);
    },
    4 * POLL_MS,
  );
});

describe("the Summary tab of a run that works", () => {
  it("should show the current step of the run and a link to Activity, and no causes", async () => {
    const { dir, runs } = await write([{ issue: 23, attempts: [{ subtask: "health", lines: await claudeLines(6) }] }]);
    const run = runs[0] as LiveRun;
    await writeRunLog(join(run.runDir, "run.json"), {
      ...run.log,
      block: { type: "integration-check", reason: "the checks failed on the integration branch", sha: "abc1234", checks: [] },
    });

    await open(dir, `/runs/${run.runId}`);

    expect(await within(panel()).findByText("Subtareas · health")).toBeDefined();
    expect(within(panel()).queryByRole("region", { name: "Bloqueo del run" })).toBeNull();
    fireEvent.click(within(panel()).getByRole("link", { name: "Ver la actividad" }));
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Actividad");
    expect(await within(panel()).findByRole("article", { name: "Worker health · attempt 1" })).toBeDefined();
  });

  it("should show the causes of a run that ended, with no current step", async () => {
    const { dir, runs } = await write([{ issue: 23, result: "draft", attempts: [{ subtask: "health", outcome: "completed" }] }]);
    const run = runs[0] as LiveRun;
    await writeRunLog(join(run.runDir, "run.json"), {
      ...run.log,
      block: { type: "integration-check", reason: "the checks failed on the integration branch", sha: "abc1234", checks: [] },
    });

    await open(dir, `/runs/${run.runId}`);

    expect(text(within(panel()).getByRole("region", { name: "Bloqueo del run" }))).toContain("Motivo: the checks failed on the integration branch");
    expect(within(panel()).queryByRole("link", { name: "Ver la actividad" })).toBeNull();
  });
});
