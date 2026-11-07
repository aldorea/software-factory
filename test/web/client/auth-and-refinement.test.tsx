// @vitest-environment jsdom
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { saveCredential } from "../../../src/config/credentials-store.ts";
import { ApiOrigin } from "../../../src/web/client/app/api.ts";
import { App } from "../../../src/web/client/app/app.tsx";
import { processStartTime } from "../../../src/web/process-start.ts";
import { startWebServer, type WebServer } from "../../../src/web/server.ts";
import { FakeClock } from "../../fakes/clock.ts";
import { CLIENT_DIR, NOW, temp } from "../web-helpers.ts";

const servers: WebServer[] = [];
const pids: number[] = [];

afterEach(async () => {
  cleanup();
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await temp.removeAll();
});

const SECRET = "sk-ant-oat01-never-in-the-page-a1f3";
const realStream = readFileSync(join(import.meta.dirname, "..", "..", "workers", "fixtures", "claude-activity.jsonl"), "utf8").trim().split("\n");

async function serve(repoDir: string, credentialsPath?: string): Promise<string> {
  const server = await startWebServer({
    repoDir,
    clientDir: CLIENT_DIR,
    port: 0,
    clock: new FakeClock(NOW.toISOString()),
    ...(credentialsPath !== undefined ? { credentials: { path: credentialsPath, environment: {} } } : {}),
    err: () => {},
  });
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

async function runningTurn(repoDir: string): Promise<void> {
  const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
  if (sleeper.pid === undefined) throw new Error("sleep did not start");
  pids.push(sleeper.pid);
  const id = "2026-10-24T07-59-00-000Z-refine-42";
  const dir = join(repoDir, ".factory", "web", id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "action.json"),
    JSON.stringify({
      version: 1,
      id,
      command: "refine",
      args: ["refine", "42", "--turn"],
      issue: 42,
      startedAt: "2026-10-24T07:59:00.000Z",
      pid: sleeper.pid,
      processStart: await processStartTime(sleeper.pid),
    }),
  );
}

describe("the credentials in Settings", () => {
  it("should list each agent with the origin of its credential and its last four characters, and never the credential", async () => {
    const config = await temp.make("client-auth-xdg-");
    const path = join(config, "credentials");
    await saveCredential(path, "claude-code", SECRET);
    draw(await serve(await temp.make("client-auth-"), path), "/settings");

    const credentials = await screen.findByRole("region", { name: "Credenciales" });
    await waitFor(() => expect(text(credentials)).toContain("saved (…a1f3)"));
    expect(text(credentials)).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(text(credentials)).toContain("OPENCODE_API_KEY");
    expect(document.body.innerHTML).not.toContain("never-in-the-page");
  });

  it("should open the form of factory auth beside the page, with the command it runs, no credential in it and the input hidden", async () => {
    draw(await serve(await temp.make("client-auth-")), "/settings");
    const credentials = await screen.findByRole("region", { name: "Credenciales" });

    fireEvent.click(await within(credentials).findByRole("link", { name: "factory auth claude-code" }));

    const panel = await screen.findByRole("complementary", { name: "Acción web" });
    expect(text(within(panel).getByLabelText("Comando"))).toBe("factory auth claude-code");
    const input = within(panel).getByLabelText("Credencial");
    expect(input).toHaveProperty("type", "password");
    fireEvent.change(input, { target: { value: SECRET } });
    expect(text(within(panel).getByLabelText("Comando"))).toBe("factory auth claude-code");
    expect(within(panel).getByRole("button", { name: "Guardar" })).toBeTruthy();
  });
});

describe("the page of the refinement of an issue", () => {
  it("should show the messages of the agent formatted and one line per tool, and a form for the answer", async () => {
    const repoDir = await temp.make("client-refine-");
    const conversation = join(repoDir, ".factory", "web", "refinement-42");
    await mkdir(join(conversation, "turns"), { recursive: true });
    await writeFile(join(conversation, "session.json"), JSON.stringify({ session: "959b71ee-9a8d-4807-90bd-b86b7e4f545c", agent: "claude-code" }));
    await writeFile(join(conversation, "turns", "2026-10-24T07-50-00-000Z-refine-42.jsonl"), `${realStream.join("\n")}\n`);
    draw(await serve(repoDir), "/refinements/42");

    const messages = await screen.findByRole("log", { name: "Conversación" });
    await waitFor(() => expect(text(messages)).toContain("The files already exist."));
    expect(within(messages).getAllByRole("listitem", { name: "Herramienta" })[0]?.textContent).toMatch(/^Bash /);
    expect(screen.getByLabelText("Respuesta")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Responder" })).toBeTruthy();
  });

  it("should offer to start the refinement when there is no conversation yet", async () => {
    draw(await serve(await temp.make("client-refine-")), "/refinements/42");

    expect(await screen.findByRole("button", { name: "Empezar el refinamiento" })).toBeTruthy();
    expect(screen.queryByLabelText("Respuesta")).toBeNull();
  });

  it("should offer Stop for the turn in progress and no answer until it ends", async () => {
    const repoDir = await temp.make("client-refine-");
    await runningTurn(repoDir);
    draw(await serve(repoDir), "/refinements/42");

    expect(await screen.findByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Responder" })).toBeNull();
  });
});
