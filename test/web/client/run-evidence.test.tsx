// @vitest-environment jsdom
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { MERGED_EARLIER } from "../../../src/coordinator/resume.ts";
import { writeRunLog, type RunLog, type VerificationRecord } from "../../../src/coordinator/run-log.ts";
import { ApiOrigin } from "../../../src/web/client/app/api.ts";
import { App } from "../../../src/web/client/app/app.tsx";
import { startWebServer, type WebServer } from "../../../src/web/server.ts";
import { attemptRecord, subtaskRecord } from "../../coordinator/run-log-fixtures.ts";
import { FakeClock } from "../../fakes/clock.ts";
import { CLIENT_DIR, NOW, aRun, temp } from "../web-helpers.ts";

const servers: WebServer[] = [];

afterEach(async () => {
  cleanup();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await temp.removeAll();
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function openRun(build: (runDir: string) => Partial<RunLog>, files: Record<string, string | Buffer> = {}, path = ""): Promise<RunLog> {
  const dir = await temp.make("client-run-evidence-");
  const base = aRun(0, { issue: 23 });
  const runDir = join(dir, ".factory", "logs", base.runId);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(runDir, name)), { recursive: true });
    await writeFile(join(runDir, name), content);
  }
  const log = { ...base, ...build(runDir) };
  await writeRunLog(join(runDir, "run.json"), log);
  const server = await startWebServer({ repoDir: dir, clientDir: CLIENT_DIR, port: 0, clock: new FakeClock(NOW.toISOString()), err: () => {} });
  servers.push(server);
  render(
    <ApiOrigin.Provider value={`http://${server.host}:${server.port}`}>
      <MemoryRouter initialEntries={[path === "" ? `/runs/${log.runId}` : path.replace("RUN", log.runId)]}>
        <App />
      </MemoryRouter>
    </ApiOrigin.Provider>,
  );
  if (path === "" || path.startsWith("/runs/")) await screen.findByRole("heading", { level: 1, name: new RegExp(log.runId) });
  return log;
}

function text(element: Element): string {
  return (element.textContent ?? "").replace(/\s+/g, " ");
}

function verification(overrides: Partial<VerificationRecord> = {}): VerificationRecord {
  return { sha: "9f8e7d6", passed: false, checks: [], criteria: [], humanCriteria: [], ...overrides };
}

describe("the causes in the Summary of a run", () => {
  it("should show each cause with where it is, what happened, its detail, the next step and a link to its evidence", async () => {
    const log = await openRun(() => ({
      result: "draft",
      subtasks: [subtaskRecord("health", { state: "blocked", blockType: "patience", block: { type: "patience", reason: "5 attempts", lastFailure: "expected 200, got 500" } })],
    }));

    const causes = screen.getByRole("region", { name: "Causas" });
    expect(text(causes)).toContain("Subtask health: blocked (patience)");
    expect(text(causes)).toContain("expected 200, got 500");
    expect(text(causes)).toContain("Revisa la spec y empieza un run nuevo: factory run 23");
    expect(screen.getByRole("link", { name: "Ver la evidencia" }).getAttribute("href")).toBe(`/runs/${log.runId}?tab=subtasks#subtask-health`);
  });

  it("should show the command of a next step that is safe as a command", async () => {
    await openRun(() => ({ result: "paused", pauseReason: "the plan limit was reached" }));

    expect(screen.getByRole("region", { name: "Causas" }).querySelector("code")?.textContent).toBe("factory run 23");
  });
});

describe("the Steps tab", () => {
  it("should show each step with its state, and say that an earlier run merged a subtask", async () => {
    await openRun(
      () => ({
        result: "draft",
        subtasks: [subtaskRecord("db", { reason: MERGED_EARLIER }), subtaskRecord("health", { state: "blocked", blockType: "scope", attempts: [attemptRecord("claude-code", 1, 1)] })],
      }),
      {},
      "/runs/RUN?tab=steps",
    );

    const steps = within(screen.getByRole("tabpanel")).getAllByRole("listitem").map(text);
    expect(steps[0]).toContain("Subtarea db");
    expect(steps[0]).toContain("passed");
    expect(steps[0]).toContain("Fusionada por un run anterior");
    expect(steps[1]).toContain("Subtarea health");
    expect(steps[1]).toContain("failed");
    expect(steps[1]).toContain("1 intentos");
    expect(steps[2]).toContain("Integrated verification");
    expect(steps[2]).toContain("not-run");
    expect(steps.at(-1)).toContain("Publicación");
  });
});

describe("the Verification and evidence tab", () => {
  it("should show the output of a failed check inside the page as text, so a <script> in it never runs", async () => {
    await openRun(() => ({ verification: verification({ checks: [{ name: "test", command: "pnpm test", exitCode: 1, passed: false, outputTail: "FAIL\n<script>window.hacked = 1</script>" }] }) }), {}, "/runs/RUN?tab=verification");

    const output = screen.getByRole("region", { name: "Integrated verification" }).querySelector("pre");
    expect(output?.textContent).toBe("FAIL\n<script>window.hacked = 1</script>");
    expect(document.querySelector("script")).toBeNull();
  });

  it("should show the screenshots inline and play the video of a criterion in the page", async () => {
    const log = await openRun(
      () => ({
        verification: verification({
          criteria: [{ id: "A3", evidence: "playwright", command: "playwright test", exitCode: 1, passed: false, evidenceFiles: ["evidence/A3/home.png", "evidence/A3/video.webm"] }],
        }),
      }),
      { "evidence/A3/home.png": PNG, "evidence/A3/video.webm": PNG },
      "/runs/RUN?tab=verification",
    );

    expect(screen.getByRole("img", { name: "evidence/A3/home.png" }).getAttribute("src")).toBe(`/runs/${log.runId}/evidence/A3/home.png`);
    expect(document.querySelector("video")?.getAttribute("src")).toBe(`/runs/${log.runId}/evidence/A3/video.webm`);
    expect(document.getElementById("verification-criterion-A3")).not.toBeNull();
  });

  it("should show the screenshot of a verdict of the acceptance tester", async () => {
    const log = await openRun(
      () => ({ verification: verification({ tester: { agent: { agent: "claude-code", model: "m" }, verdicts: [{ id: "A1", passed: false, observation: "no button", evidence: ["tester/A1.png"] }] } }) }),
      { "tester/A1.png": PNG },
      "/runs/RUN?tab=verification",
    );

    expect(screen.getByRole("img", { name: "tester/A1.png" }).getAttribute("src")).toBe(`/runs/${log.runId}/tester/A1.png`);
  });
});

describe("the Subtasks tab", () => {
  it("should fold a merged subtask and keep a blocked one open", async () => {
    await openRun(() => ({ result: "draft", subtasks: [subtaskRecord("db"), subtaskRecord("health", { state: "blocked", blockType: "patience" })] }), {}, "/runs/RUN?tab=subtasks");

    const folded = [...document.querySelectorAll("details")].map((details) => [details.querySelector("summary")?.textContent, details.open]);
    expect(folded).toEqual([
      ["db · merged", false],
      ["health · blocked", true],
    ]);
  });
});

describe("the raw logs on the page of a run", () => {
  it("should link no .jsonl in any tab", async () => {
    await openRun(
      (runDir) => ({
        subtasks: [
          subtaskRecord("S1", {
            attempts: [{ ...attemptRecord("claude-code", 1, 1), logPath: join(runDir, "S1-attempt-1.jsonl") }],
            gate: { sha: "abc", accepted: true, reasons: [], checks: [], criteria: [], verifier: [{ id: "A1", verdict: "accept", logPath: join(runDir, "S1-verifier.jsonl") }] },
          }),
        ],
        verification: verification({ tester: { agent: { agent: "claude-code", model: "m" }, verdicts: [], logPath: "tester.jsonl" } }),
      }),
      { "S1-attempt-1.jsonl": "{}", "S1-verifier.jsonl": "{}", "tester.jsonl": "{}" },
    );

    for (const tab of ["Resumen", "Pasos", "Verificación y evidencia", "Subtareas"]) {
      fireEvent.click(screen.getByRole("tab", { name: tab }));
      expect(document.body.innerHTML).not.toContain(".jsonl");
    }
  });
});

describe("the list of runs", () => {
  it("should show the first cause of a run that is not ready", async () => {
    await openRun(() => ({ result: "draft", subtasks: [subtaskRecord("health", { state: "blocked", blockType: "patience" })] }), {}, "/");

    expect(await screen.findByText("Subtask health: blocked (patience)")).toBeDefined();
  });
});
