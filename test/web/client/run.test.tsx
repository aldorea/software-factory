// @vitest-environment jsdom
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BrowserRouter, MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { writeRunLog, type RunLog, type VerificationRecord } from "../../../src/coordinator/run-log.ts";
import { ApiOrigin } from "../../../src/web/client/app/api.ts";
import { App } from "../../../src/web/client/app/app.tsx";
import { runStatusTone, subtaskStateTone } from "../../../src/web/client/app/tones.ts";
import { startWebServer, type WebServer } from "../../../src/web/server.ts";
import { attemptRecord, subtaskRecord } from "../../coordinator/run-log-fixtures.ts";
import { FakeClock } from "../../fakes/clock.ts";
import { CLIENT_DIR, NOW, aRun, repoWithRuns, temp } from "../web-helpers.ts";

const servers: WebServer[] = [];

afterEach(async () => {
  cleanup();
  window.history.replaceState(null, "", "/");
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

async function openRun(log: RunLog, tab?: string, modifiedAt?: Date): Promise<string> {
  const dir = await repoWithRuns([{ log, modifiedAt }]);
  draw(await serve(dir), `/runs/${log.runId}${tab === undefined ? "" : `?tab=${tab}`}`);
  await screen.findByRole("heading", { level: 1, name: new RegExp(log.runId) });
  return dir;
}

function text(element: Element): string {
  return (element.textContent ?? "").replace(/\s+/g, " ");
}

function panel(): string {
  return text(screen.getByRole("tabpanel"));
}

function verification(overrides: Partial<VerificationRecord> = {}): VerificationRecord {
  return { sha: "9f8e7d6", passed: false, checks: [], criteria: [], humanCriteria: [], ...overrides };
}

describe("the page of a run in the client", () => {
  it("should show the issue, the run ID, the result and the age of the last change", async () => {
    const log = aRun(0, { issue: 45, result: "draft" });

    await openRun(log, undefined, new Date(NOW.getTime() - 7 * 60_000));

    const header = text(screen.getByRole("region", { name: "Run" }));
    expect(header).toContain(`#45 ${log.runId}`);
    expect(header).toContain("draft");
    expect(header).toContain("Último cambio: hace 7 min");
  });

  it("should open the run from the link of the list of runs without leaving the client", async () => {
    const log = aRun(0, { issue: 45 });
    draw(await serve(await repoWithRuns([{ log }])), "/");

    fireEvent.click(await screen.findByRole("link", { name: log.runId }));

    expect(await screen.findByRole("heading", { level: 1, name: `#45 ${log.runId}` })).toBeDefined();
  });

  it("should show the not found page for a run ID with no run.json", async () => {
    draw(await serve(await repoWithRuns([{ log: aRun(0) }])), "/runs/45-2026-10-01T00-00-00-000Z");

    expect(await screen.findByRole("heading", { name: "Página no encontrada" })).toBeDefined();
  });

  it.each(["/runs/%2e%2e", "/runs/1-run-00", "/runs/<script>"])("should show the not found page for %s, which is not a run ID", async (path) => {
    draw(await serve(await repoWithRuns([{ log: aRun(0) }])), path);

    expect(await screen.findByRole("heading", { name: "Página no encontrada" })).toBeDefined();
  });

  it("should draw every text of run.json as text, never as HTML", async () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const log = aRun(0, {
      result: "paused",
      pauseReason: hostile,
      agents: { workers: { agent: "claude-code", model: hostile }, changes: [] },
      criteria: { passing: [hostile], blocked: [], human: [], pending: [] },
      block: { type: "default-branch-conflict", reason: hostile, sha: hostile, files: [hostile] },
      publicationFailure: { phase: "evidence-push", message: hostile, at: hostile },
      subtasks: [subtaskRecord(hostile, { criteria: [hostile] })],
      verification: verification({ humanCriteria: [{ id: "H1", reason: hostile, attachments: [] }] }),
    });

    await openRun(log);
    expect(panel()).toContain(hostile);
    for (const tab of ["Subtareas", "Verificación y evidencia"]) {
      fireEvent.click(screen.getByRole("tab", { name: tab }));
      expect(panel()).toContain(hostile);
    }

    expect(document.querySelector("img")).toBeNull();
  });

  it("should ask again while the run is running and stop when it ends", async () => {
    const { endedAt: _ended, ...base } = aRun(0);
    const log: RunLog = { ...base, result: "running" };
    const dir = await openRun(log, undefined, NOW);
    expect(text(screen.getByRole("region", { name: "Run" }))).toContain("running");

    await writeRunLog(join(dir, ".factory", "logs", log.runId, "run.json"), { ...log, result: "ready" });

    await waitFor(() => expect(text(screen.getByRole("region", { name: "Run" }))).toContain("ready"), { timeout: 5000 });
  });
});

describe("the tabs of the page of a run", () => {
  it("should have the tabs Summary, Steps, Verification and evidence, Subtasks and Activity, with Summary first", async () => {
    await openRun(aRun(0));

    expect(screen.getAllByRole("tab").map(text)).toEqual(["Resumen", "Pasos", "Verificación y evidencia", "Subtareas", "Actividad"]);
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Resumen");
  });

  it.each([
    ["steps", "Pasos"],
    ["verification", "Verificación y evidencia"],
    ["subtasks", "Subtareas"],
    ["activity", "Actividad"],
  ])("should open the tab of ?tab=%s, so a link to a tab survives a reload", async (tab, name) => {
    await openRun(aRun(0), tab);

    expect(screen.getByRole("tab", { selected: true }).textContent).toBe(name);
  });

  it("should open Summary for a tab it does not know", async () => {
    await openRun(aRun(0), "nope");

    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Resumen");
  });

  it("should put each tab in the URL and move between tabs with back and forward", async () => {
    const log = aRun(0);
    const origin = await serve(await repoWithRuns([{ log }]));
    window.history.pushState(null, "", `/runs/${log.runId}`);
    render(
      <ApiOrigin.Provider value={origin}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ApiOrigin.Provider>,
    );
    await screen.findByRole("heading", { level: 1, name: new RegExp(log.runId) });

    fireEvent.click(screen.getByRole("tab", { name: "Subtareas" }));
    expect(window.location.search).toBe("?tab=subtasks");
    fireEvent.click(screen.getByRole("tab", { name: "Verificación y evidencia" }));
    expect(window.location.search).toBe("?tab=verification");

    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Subtareas");
    await act(async () => {
      window.history.forward();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Verificación y evidencia");
  });

  it("should say in Activity that no agent of a run with no attempt has started", async () => {
    await openRun(aRun(0, { subtasks: [] }), "activity");

    expect(await screen.findByText("Ningún agente de este run ha empezado todavía.")).toBeDefined();
  });
});

describe("the Summary tab", () => {
  it("should show the agent and the model of each role, and each change of agent with its time", async () => {
    const log = aRun(0, {
      agents: {
        workers: { agent: "opencode", model: "opencode-go/kimi-k2" },
        verifier: { agent: "claude-code", model: "opus" },
        changes: [{ role: "workers", from: { agent: "claude-code", model: "sonnet" }, to: { agent: "opencode", model: "opencode-go/kimi-k2" }, at: "2026-10-24T07:30:00.000Z" }],
      },
    });

    await openRun(log);

    const agents = text(screen.getByRole("region", { name: "Agentes" }));
    expect(agents).toContain("workers: opencode / opencode-go/kimi-k2");
    expect(agents).toContain("verifier: claude-code / opus");
    expect(agents).not.toContain("tester:");
    expect(agents).toContain("Cambios de agente");
    expect(agents).toContain("workers: claude-code / sonnet → opencode / opencode-go/kimi-k2 (2026-10-24T07:30:00.000Z)");
  });

  it("should not show a section of agent changes when the run never changed agent", async () => {
    await openRun(aRun(0));

    expect(panel()).not.toContain("Cambios de agente");
  });

  it("should show the passing, blocked, human and pending criteria each under its own heading, an empty one as none", async () => {
    await openRun(aRun(0, { criteria: { passing: ["C1", "C2"], blocked: [], human: ["C4"], pending: ["C5"] } }));

    const criteria = screen.getByRole("region", { name: "Criterios" });
    const group = (name: string) => text(within(criteria).getByRole("list", { name }));
    expect(group("Pasan")).toBe("C1C2");
    expect(group("Bloqueados")).toBe("Ninguno");
    expect(group("Human")).toBe("C4");
    expect(group("Pendientes")).toBe("C5");
  });

  it("should show the reason of a pause and the reset of the plan limit, or that it is unknown", async () => {
    await openRun(aRun(0, { result: "paused", pauseReason: "the plan limit of claude-code was reached" }));

    const pause = text(screen.getByRole("region", { name: "Pausado" }));
    expect(pause).toContain("Motivo: the plan limit of claude-code was reached");
    expect(pause).toContain("Reset del plan limit: desconocido");
  });

  it("should show no pause, block or publication failure for a run that has none", async () => {
    await openRun(aRun(0));

    expect(screen.queryByRole("region", { name: "Pausado" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Bloqueo del run" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Sin publicar" })).toBeNull();
  });

  it("should show the block of the run with its checks and the first error of a failed check", async () => {
    await openRun(
      aRun(0, {
        result: "draft",
        block: {
          type: "integration-check",
          reason: "the checks failed on the integration branch",
          sha: "abc1234",
          checks: [{ name: "unit-tests", command: "pnpm test", exitCode: 1, passed: false, firstError: "2 tests failed" }],
        },
      }),
    );

    const block = text(screen.getByRole("region", { name: "Bloqueo del run" }));
    expect(block).toContain("Tipo: integration-check");
    expect(block).toContain("Motivo: the checks failed on the integration branch");
    expect(block).toContain("Commit: abc1234");
    expect(block).toContain("unit-tests: falla (2 tests failed)");
  });

  it("should show the files of a default-branch-conflict block", async () => {
    await openRun(aRun(0, { result: "draft", block: { type: "default-branch-conflict", reason: "it conflicts", sha: "def5678", files: ["src/a.ts", "src/b.ts"] } }));

    const block = text(screen.getByRole("region", { name: "Bloqueo del run" }));
    expect(block).toContain("src/a.ts");
    expect(block).toContain("src/b.ts");
  });

  it("should show the phase, the message, the time and the command that publishes again of a run not published", async () => {
    await openRun(aRun(0, { issue: 27, publicationFailure: { phase: "integration-push", message: "Operation timed out", at: "2026-10-24T07:30:00.000Z" } }));

    const failure = text(screen.getByRole("region", { name: "Sin publicar" }));
    expect(failure).toContain("Fase: integration-push");
    expect(failure).toContain("Motivo: Operation timed out");
    expect(failure).toContain("Hora: 2026-10-24T07:30:00.000Z");
    expect(failure).toContain("Para publicar de nuevo: factory publish 27");
  });

  it("should link the pull request, say it is a draft, and link the evidence branch", async () => {
    await openRun(
      aRun(0, {
        pullRequest: { number: 52, url: "https://github.com/acme/app/pull/52", draft: true },
        evidence: { branch: "factory-evidence/45", repositoryUrl: "https://github.com/acme/app" },
      }),
    );

    expect(screen.getByRole("link", { name: "#52" }).getAttribute("href")).toBe("https://github.com/acme/app/pull/52");
    expect(panel()).toContain("#52 (draft)");
    expect(screen.getByRole("link", { name: "factory-evidence/45" }).getAttribute("href")).toBe("https://github.com/acme/app/tree/factory-evidence/45");
  });

  it("should not link a url that the API gives as unsafe, and still show its text", async () => {
    await openRun(aRun(0, { pullRequest: { number: 1, url: "javascript:alert(1)", draft: false }, evidence: { branch: "b", repositoryUrl: "javascript:alert(2)" } }));

    expect(panel()).toContain("Pull request: #1");
    expect(screen.queryByRole("link", { name: "#1" })).toBeNull();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });
});

describe("the Subtasks tab", () => {
  it("should show each subtask with its state, criteria, branch, scope extensions, attempts, gate and follow-up tasks", async () => {
    const attempt = {
      ...attemptRecord("opencode", 1000, 250),
      number: 2,
      agent: { agent: "opencode" as const, model: "opencode-go/kimi-k2" },
      outcome: "agent-error" as const,
      failure: { signature: "sig-1", description: "typecheck failed in src/a.ts" },
      startedAt: "2026-10-24T08:00:00.000Z",
      endedAt: "2026-10-24T08:12:00.000Z",
    };
    const subtask = subtaskRecord("S1", {
      state: "merged",
      criteria: ["C1", "C2"],
      branch: "factory-subtask/1-x/S1",
      scopeExtensions: ["src/extra.ts"],
      attempts: [attempt],
      gateRejections: 2,
      verifierRejections: 1,
      gate: {
        sha: "abc1234",
        accepted: false,
        reasons: ["the independent verifier refuted C2"],
        checks: [{ name: "test", command: "pnpm test", exitCode: 1, passed: false, firstError: "1 test failed" }],
        criteria: [{ id: "C1", evidence: "request", command: "curl x", exitCode: 0, passed: true }],
        verifier: [{ id: "C2", verdict: "refute", reason: "the button is missing", logPath: "/logs/v2.jsonl" }],
      },
      followUps: [{ round: 1, criteria: ["C1"], failure: "the tester refuted C1", outcome: "merged" }],
    });

    await openRun(aRun(0, { subtasks: [subtask] }), "subtasks");

    const shown = text(screen.getByRole("region", { name: "S1" }));
    for (const line of [
      "Estado: merged",
      "Criterios: C1, C2",
      "Branch: factory-subtask/1-x/S1",
      "Scope extensions: src/extra.ts",
      "Intento 2: opencode / opencode-go/kimi-k2",
      "Resultado: agent-error",
      "Fallo: typecheck failed in src/a.ts",
      "Tokens: 1250",
      "Inicio: 2026-10-24T08:00:00.000Z",
      "Fin: 2026-10-24T08:12:00.000Z",
      "2 rechazos del gate",
      "1 rechazos del independent verifier",
      "Gate abc1234: rechazado",
      "the independent verifier refuted C2",
      "test: falla (1 test failed)",
      "C1: pasa",
      "C2: refute (the button is missing)",
      "Follow-up ronda 1",
      "Fallo: the tester refuted C1",
    ]) {
      expect(shown).toContain(line);
    }
  });

  it("should show the type, the reason and the last failure of a blocked subtask", async () => {
    const subtask = subtaskRecord("S1", {
      state: "blocked",
      blockType: "patience",
      reason: "five attempts without progress",
      block: { type: "patience", reason: "five attempts without progress", lastFailure: "typecheck failed in src/a.ts" },
    });

    await openRun(aRun(0, { subtasks: [subtask] }), "subtasks");

    const shown = text(screen.getByRole("region", { name: "S1" }));
    expect(shown).toContain("Bloqueo: patience");
    expect(shown).toContain("Motivo: five attempts without progress");
    expect(shown).toContain("Último fallo: typecheck failed in src/a.ts");
  });

  it("should say that a run has no subtasks yet when it has none", async () => {
    await openRun(aRun(0, { subtasks: [] }), "subtasks");

    expect(panel()).toContain("Sin subtareas");
  });
});

describe("the Verification and evidence tab", () => {
  it("should show the sha, the result, the environment, the checks, the criteria, the human criteria and the acceptance tester", async () => {
    const log = aRun(0, {
      verification: verification({
        environment: "the dev server did not start",
        checks: [{ name: "test", command: "pnpm test", exitCode: 1, passed: false, firstError: "2 tests failed" }],
        criteria: [{ id: "C1", evidence: "playwright", command: "playwright test", exitCode: 1, passed: false }],
        humanCriteria: [{ id: "H1", reason: "the layout needs a human eye", attachments: ["screens/home.png"] }],
        tester: {
          agent: { agent: "claude-code", model: "sonnet" },
          verdicts: [{ id: "C2", passed: false, observation: "the button is missing", evidence: ["shot.png"] }],
          error: "the tester stopped early",
        },
      }),
    });

    await openRun(log, "verification");

    const shown = panel();
    for (const line of [
      "SHA: 9f8e7d6",
      "Resultado: falla",
      "Entorno: the dev server did not start",
      "test: falla (2 tests failed)",
      "C1: falla",
      "H1: the layout needs a human eye (screens/home.png)",
      "Agente: claude-code / sonnet",
      "C2: falla (the button is missing) [shot.png]",
      "Error: the tester stopped early",
    ]) {
      expect(shown).toContain(line);
    }
  });

  it("should say there is no integrated verification yet when the run has none", async () => {
    await openRun(aRun(0, { result: "running" }), "verification");

    expect(panel()).toContain("Todavía sin integrated verification");
  });
});

describe("the links of the page of a run to its files", () => {
  async function runWithFiles(build: (runDir: string) => Partial<RunLog>, files: Record<string, string>): Promise<RunLog> {
    const dir = await temp.make("client-run-files-");
    const base = aRun(0);
    const runDir = join(dir, ".factory", "logs", base.runId);
    for (const [name, content] of Object.entries(files)) {
      await mkdir(dirname(join(runDir, name)), { recursive: true });
      await writeFile(join(runDir, name), content);
    }
    const log = { ...base, ...build(runDir) };
    await writeRunLog(join(runDir, "run.json"), log);
    draw(await serve(dir), `/runs/${base.runId}?tab=subtasks`);
    await screen.findByRole("heading", { level: 1, name: new RegExp(base.runId) });
    return log;
  }

  it("should link the full output of a failed check to the files of the run, and never the raw log of an attempt", async () => {
    const log = await runWithFiles(
      (runDir) => ({
        subtasks: [
          subtaskRecord("S1", {
            attempts: [{ ...attemptRecord("claude-code", 10, 5), logPath: join(runDir, "S1-attempt-1.jsonl") }],
            gate: {
              sha: "abc1234",
              accepted: false,
              reasons: [],
              criteria: [],
              verifier: [],
              checks: [{ name: "test", command: "pnpm test", exitCode: 1, passed: false, outputLog: "output/gate/check-2-test.log" }],
            },
          }),
        ],
      }),
      { "S1-attempt-1.jsonl": "{}\n", "output/gate/check-2-test.log": "boom\n" },
    );

    expect(document.querySelector('a[href$=".jsonl"]')).toBeNull();
    expect(screen.getByRole("link", { name: "Salida completa" }).getAttribute("href")).toBe(`/runs/${log.runId}/output/gate/check-2-test.log`);
  });

  it("should not link a file that the API does not link, because it is outside the run folder", async () => {
    const gate = { sha: "abc1234", accepted: false, reasons: [], criteria: [], verifier: [], checks: [{ name: "test", command: "pnpm test", exitCode: 1, passed: false, outputLog: "/etc/passwd" }] };
    await runWithFiles(() => ({ subtasks: [subtaskRecord("S1", { attempts: [attemptRecord("claude-code", 10, 5)], gate })] }), {});

    expect(text(screen.getByRole("region", { name: "S1" }))).toContain("Intento 1");
    expect(screen.queryByRole("link", { name: "Salida completa" })).toBeNull();
  });
});

describe("the tone of a badge", () => {
  it("should colour a ready run as ok and a blocked subtask as bad", () => {
    expect(runStatusTone("ready")).toBe("ok");
    expect(subtaskStateTone("blocked")).toBe("bad");
  });

  it("should not take a tone from a property of Object, because a run.json value can be any string", () => {
    expect(subtaskStateTone("constructor")).toBe("neutral");
    expect(subtaskStateTone("__proto__")).toBe("neutral");
  });
});
