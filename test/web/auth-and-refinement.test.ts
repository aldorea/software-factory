import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveCredential } from "../../src/config/credentials-store.ts";
import { handleRequest, type WebResponse } from "../../src/web/handler.ts";
import { processStartTime } from "../../src/web/process-start.ts";
import type { AuthPage } from "../../src/web/auth-api.ts";
import type { RefinementConversation } from "../../src/web/refinement-api.ts";
import { PORT, TOKEN, request, temp } from "./web-helpers.ts";

const pids: number[] = [];
afterEach(async () => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  await temp.removeAll();
});

const ORIGIN = `http://127.0.0.1:${PORT}`;
const COOKIE = `factory-token=${TOKEN}`;
const SECRET = "sk-ant-oat01-never-shown-a1f3";
const ANSWER = "1. Keep the saved searches per user, not per team";
const realStream = readFileSync(join(import.meta.dirname, "..", "workers", "fixtures", "claude-activity.jsonl"), "utf8").trim().split("\n");

function post(repoDir: string, body: object) {
  return handleRequest(request(repoDir, "/api/actions", { method: "POST", body: JSON.stringify(body), origin: ORIGIN, cookie: COOKIE }));
}

function bodyOf<T>(response: WebResponse): T {
  return JSON.parse(String(response.body)) as T;
}

async function runningRefineTurn(repoDir: string, issue: number): Promise<string> {
  const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
  if (sleeper.pid === undefined) throw new Error("sleep did not start");
  pids.push(sleeper.pid);
  const id = `2026-10-24T07-59-00-000Z-refine-${issue}`;
  const dir = join(repoDir, ".factory", "web", id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "action.json"),
    JSON.stringify({
      version: 1,
      id,
      command: "refine",
      args: ["refine", String(issue), "--turn"],
      issue,
      startedAt: "2026-10-24T07:59:00.000Z",
      pid: sleeper.pid,
      processStart: await processStartTime(sleeper.pid),
    }),
  );
  return id;
}

describe("the auth web action", () => {
  it("should pass the credential on the standard input of factory auth, never in its arguments or in the response", async () => {
    const dir = await temp.make("web-auth-");

    const response = await post(dir, { command: "auth", agent: "claude-code", credential: SECRET });

    expect(response.status).toBe(202);
    expect(response.start).toEqual({
      id: "2026-10-24T08-00-00-000Z-auth",
      command: "auth",
      args: ["auth", "claude-code"],
      issue: null,
      stdin: `${SECRET}\n`,
    });
    expect(String(response.body)).not.toContain(SECRET);
  });

  it("should pass --force only when the form asks for it", async () => {
    const dir = await temp.make("web-auth-");

    const response = await post(dir, { command: "auth", agent: "claude-code", credential: "not-a-setup-token", force: true });

    expect(response.start?.args).toEqual(["auth", "claude-code", "--force"]);
  });

  it.each([
    ["an empty value", "", "the credential is empty"],
    ["a value with a space", "sk-ant-oat01 a1f3", "the credential has a space or a line break, which would break the env file of the container"],
    ["a value with a line break", "sk-ant-oat01\na1f3", "the credential has a space or a line break, which would break the env file of the container"],
  ])("should refuse %s as the CLI does, and start nothing", async (_, credential, problem) => {
    const dir = await temp.make("web-auth-");

    const response = await post(dir, { command: "auth", agent: "claude-code", credential });

    expect(response.status).toBe(400);
    expect(bodyOf<{ error: string }>(response).error).toBe(problem);
    expect(response.start).toBeUndefined();
  });

  it("should refuse an agent that does not exist", async () => {
    const dir = await temp.make("web-auth-");

    const response = await post(dir, { command: "auth", agent: "gpt", credential: SECRET });

    expect(response.status).toBe(400);
    expect(String(response.body)).not.toContain(SECRET);
  });

  it("should show each agent with the origin of its credential and its last four characters, as the CLI does, and never the credential", async () => {
    const dir = await temp.make("web-auth-");
    const config = await temp.make("web-auth-xdg-");
    const path = join(config, "credentials");
    await saveCredential(path, "claude-code", SECRET);

    const response = await handleRequest(request(dir, "/api/auth", { credentials: { path, environment: { OPENCODE_API_KEY: "from-env-key" } } }));

    expect(response.status).toBe(200);
    expect(bodyOf<AuthPage>(response).agents.map(({ agent, variable, origin }) => ({ agent, variable, origin }))).toEqual([
      { agent: "claude-code", variable: "CLAUDE_CODE_OAUTH_TOKEN", origin: "saved (…a1f3)" },
      { agent: "opencode", variable: "OPENCODE_API_KEY", origin: "from environment (wins over saved)" },
    ]);
    expect(String(response.body)).not.toContain("never-shown");
    expect(String(response.body)).not.toContain("from-env-key");
  });
});

describe("the refinement web action", () => {
  it("should start one turn with the answer on standard input, never in the arguments", async () => {
    const dir = await temp.make("web-refine-");

    const response = await post(dir, { command: "refine", issue: 42, agent: { agent: "claude-code", model: "sonnet" }, answer: ANSWER });

    expect(response.status).toBe(202);
    expect(response.start).toEqual({
      id: "2026-10-24T08-00-00-000Z-refine-42",
      command: "refine",
      args: ["refine", "42", "--turn", "--refinement-agent", "claude-code:sonnet"],
      issue: 42,
      stdin: ANSWER,
    });
    expect(String(response.body)).not.toContain("per user");
  });

  it("should start the first turn with no standard input when there is no answer", async () => {
    const dir = await temp.make("web-refine-");

    const response = await post(dir, { command: "refine", issue: 42 });

    expect(response.start).toEqual({ id: "2026-10-24T08-00-00-000Z-refine-42", command: "refine", args: ["refine", "42", "--turn"], issue: 42 });
  });

  it("should refuse a second turn of the same issue while one is in progress", async () => {
    const dir = await temp.make("web-refine-");
    const id = await runningRefineTurn(dir, 42);

    const response = await post(dir, { command: "refine", issue: 42, answer: ANSWER });

    expect(response.status).toBe(409);
    expect(bodyOf<{ error: string }>(response).error).toContain("a turn of the refinement of #42 is in progress since");
    expect(bodyOf<{ error: string }>(response).error).toContain(id);
    expect(response.start).toBeUndefined();
  });

  it("should rebuild the conversation from the files of the turns, with the messages of the agent formatted and one line per tool", async () => {
    const dir = await temp.make("web-refine-");
    const conversation = join(dir, ".factory", "web", "refinement-42");
    await mkdir(join(conversation, "turns"), { recursive: true });
    await writeFile(join(conversation, "session.json"), JSON.stringify({ session: "959b71ee-9a8d-4807-90bd-b86b7e4f545c", agent: "claude-code" }));
    await writeFile(join(conversation, "turns", "2026-10-24T07-50-00-000Z-refine-42.jsonl"), `${realStream.join("\n")}\n`);

    const response = await handleRequest(request(dir, "/api/refinements/42"));

    expect(response.status).toBe(200);
    const body = bodyOf<RefinementConversation>(response);
    expect(body.started).toBe(true);
    expect(body.turns.map((turn) => turn.id)).toEqual(["2026-10-24T07-50-00-000Z-refine-42"]);
    const messages = body.turns[0]?.messages ?? [];
    expect(messages[0]).toEqual({ kind: "tool", text: expect.stringMatching(/^Bash /) });
    expect(messages.filter((message) => message.kind === "text")[0]?.text).toMatch(/^The files already exist\. Next I'll /);
    expect(messages.at(-1)).toEqual({ kind: "end", text: "completed" });
    expect(body.current).toBeNull();
  });

  it("should give the turn in progress, so the page offers Stop for it", async () => {
    const dir = await temp.make("web-refine-");
    const id = await runningRefineTurn(dir, 42);

    const body = bodyOf<RefinementConversation>(await handleRequest(request(dir, "/api/refinements/42")));

    expect(body.started).toBe(false);
    expect(body.current).toMatchObject({ id, canStop: true });
  });
});
