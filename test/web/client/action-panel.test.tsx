// @vitest-environment jsdom
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { ApiOrigin } from "../../../src/web/client/app/api.ts";
import { App } from "../../../src/web/client/app/app.tsx";
import { processStartTime } from "../../../src/web/process-start.ts";
import { startWebServer, type WebServer } from "../../../src/web/server.ts";
import type { WebActionRecord } from "../../../src/web/web-action.ts";
import { pausedRun } from "../../coordinator/run-log-fixtures.ts";
import { FakeClock } from "../../fakes/clock.ts";
import { CLIENT_DIR, NOW, aRun, repoWithRuns, temp } from "../web-helpers.ts";

const servers: WebServer[] = [];

afterEach(async () => {
  cleanup();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await temp.removeAll();
});

async function serve(repoDir: string): Promise<string> {
  const server = await startWebServer({ repoDir, clientDir: CLIENT_DIR, port: 0, clock: new FakeClock(NOW.toISOString()), err: () => {} });
  servers.push(server);
  return `http://${server.host}:${server.port}`;
}

function draw(origin: string, path: string): void {
  render(
    <ApiOrigin.Provider value={origin}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </ApiOrigin.Provider>,
  );
}

function text(element: Element): string {
  return (element.textContent ?? "").replace(/\s+/g, " ");
}

async function panel(): Promise<HTMLElement> {
  return screen.findByRole("complementary", { name: "Acción web" });
}

async function commandIn(element: HTMLElement): Promise<string> {
  return text(await within(element).findByLabelText("Comando"));
}

async function withAction(repoDir: string, record: Partial<WebActionRecord> & { id: string }, end?: object, output?: string): Promise<void> {
  const dir = join(repoDir, ".factory", "web", record.id);
  await mkdir(dir, { recursive: true });
  const full: WebActionRecord = {
    version: 1,
    command: "validate",
    args: ["validate", "45"],
    issue: 45,
    startedAt: "2026-10-24T07:58:00.000Z",
    pid: process.pid,
    processStart: await processStartTime(process.pid),
    ...record,
  };
  await writeFile(join(dir, "action.json"), JSON.stringify(full));
  if (end !== undefined) await writeFile(join(dir, "end.json"), JSON.stringify(end));
  if (output !== undefined) await writeFile(join(dir, "output.log"), output);
}

describe("the panel of a web action", () => {
  it("should open the form of factory run from the next step of a paused run, filled in with the roles of the paused run", async () => {
    const log = { ...aRun(0, { ...pausedRun(0), issue: 45 }), runId: "45-2026-10-10T08-00-00-000Z" };
    draw(await serve(await repoWithRuns([{ log }])), `/runs/${log.runId}`);
    const causes = await screen.findByRole("region", { name: "Causas" });

    fireEvent.click(within(causes).getByRole("link", { name: "factory run 45" }));

    const opened = await panel();
    await waitFor(async () => expect(await commandIn(opened)).toBe("factory run 45 --worker-agent claude-code:m"));
    expect(text(opened)).toContain("(paused run)");
    expect((within(opened).getByLabelText("Modelo: workers") as HTMLInputElement).value).toBe("m");
  });

  it("should change the command of the form when the developer chooses another model, as the menu of the CLI does", async () => {
    const log = { ...aRun(0, { ...pausedRun(0), issue: 45 }), runId: "45-2026-10-10T08-00-00-000Z" };
    draw(await serve(await repoWithRuns([{ log }])), `/runs/${log.runId}?form=run&issue=45`);
    const opened = await panel();
    const model = await within(opened).findByLabelText("Modelo: workers");

    fireEvent.change(model, { target: { value: "opus" } });

    expect(await commandIn(opened)).toBe("factory run 45 --worker-agent claude-code:opus");
  });

  it("should open the form of factory publish from the next step of a run whose publication failed", async () => {
    const log = aRun(0, { issue: 45, result: "draft", publicationFailure: { phase: "integration-push", message: "x", at: "2026-10-24T07:00:00.000Z" } });
    draw(await serve(await repoWithRuns([{ log }])), `/runs/${log.runId}`);
    const causes = await screen.findByRole("region", { name: "Causas" });

    fireEvent.click(within(causes).getByRole("link", { name: "factory publish 45" }));

    expect(await commandIn(await panel())).toBe("factory publish 45");
  });

  it("should show the output and the exit code of a web action that ended, with no Stop", async () => {
    const dir = await repoWithRuns([]);
    const id = "2026-10-24T07-58-00-000Z-validate-45";
    await withAction(dir, { id }, { exitCode: 1, endedAt: "2026-10-24T07:58:02.000Z" }, "specs/45.md is invalid\n");
    draw(await serve(dir), `/?action=${id}`);
    const opened = await panel();

    expect(text(await within(opened).findByLabelText("Salida"))).toContain("specs/45.md is invalid");
    expect(text(opened)).toContain("exit 1");
    expect(within(opened).queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("should offer Stop for a web action that is still working", async () => {
    const dir = await repoWithRuns([]);
    const id = "2026-10-24T07-58-00-000Z-run-45";
    await withAction(dir, { id, command: "run", args: ["run", "45"] });
    draw(await serve(dir), `/?action=${id}`);
    const opened = await panel();

    expect(await within(opened).findByRole("button", { name: "Stop" })).toBeDefined();
    expect(text(opened)).toContain("working");
  });

  it("should show a web action whose process is gone as interrupted, with no Stop", async () => {
    const dir = await repoWithRuns([]);
    const id = "2026-10-24T07-58-00-000Z-run-45";
    await withAction(dir, { id, command: "run", args: ["run", "45"], processStart: "Thu Jan  1 00:00:00 1970" });
    draw(await serve(dir), `/?action=${id}`);
    const opened = await panel();

    await waitFor(() => expect(text(opened)).toContain("interrupted"));
    expect(within(opened).queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("should show the last web action of the issue on the page of the run, and open its panel", async () => {
    const log = aRun(0, { issue: 45 });
    const dir = await repoWithRuns([{ log }]);
    await withAction(dir, { id: "2026-10-24T07-58-00-000Z-validate-45" }, { exitCode: 0, endedAt: "2026-10-24T07:58:02.000Z" });
    draw(await serve(dir), `/runs/${log.runId}`);

    fireEvent.click(await screen.findByRole("link", { name: /Última acción web/ }));

    expect(await commandIn(await panel())).toBe("factory validate 45");
  });
});
