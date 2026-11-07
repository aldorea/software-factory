import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clockMinutes } from "../../src/cli/clock-time.ts";
import { main, type CliEnv } from "../../src/cli/main.ts";
import { processStartTime } from "../../src/web/process-start.ts";
import { execOk } from "../../src/workers/sh.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeGitHub } from "../fakes/github.ts";
import { FakeImageDocker } from "../fakes/image-docker.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeVerifier } from "../fakes/verifier.ts";
import { FakeWorkerRunner } from "../fakes/worker-runner.ts";
import { isAlive } from "../process-alive.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
const pids: number[] = [];
afterEach(async () => {
  for (const pid of pids.splice(0)) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {}
    }
  }
  await temp.removeAll();
});

const FACTORY_ROOT = join(import.meta.dirname, "..", "..");
const realStream = readFileSync(join(import.meta.dirname, "..", "workers", "fixtures", "claude-activity.jsonl"), "utf8").trim().split("\n");
const defaultInit = readFileSync(join(import.meta.dirname, "..", "workers", "fixtures", "claude-init-default.jsonl"), "utf8").trim();
const SESSION = "959b71ee-9a8d-4807-90bd-b86b7e4f545c";
const ANSWER = "1. Keep the saved searches per user, not per team";
const LIST_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "Bash"];

function withTheList(line: string): string {
  return JSON.stringify({ ...(JSON.parse(line) as object), tools: LIST_TOOLS, mcp_servers: [], permissionMode: "default" });
}

const loadedStream = [withTheList(realStream[0] ?? ""), ...realStream.slice(1)];

async function git(dir: string, ...args: string[]): Promise<string> {
  return (await execOk("git", ["-C", dir, ...args])).trim();
}

async function targetRepo(): Promise<string> {
  const dir = await temp.make("refine-turn-");
  await execOk("git", ["init", "-q", "-b", "main", dir]);
  await git(dir, "config", "user.name", "t");
  await git(dir, "config", "user.email", "t@t");
  await writeFile(join(dir, "README.md"), "# target\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
  const remoteDir = await temp.make("refine-turn-remote-");
  await execOk("git", ["init", "-q", "--bare", "-b", "main", remoteDir]);
  await git(dir, "remote", "add", "origin", remoteDir);
  await git(dir, "push", "-q", "origin", "main");
  await git(dir, "remote", "set-head", "origin", "--auto");
  return dir;
}

interface StubAgent {
  command: string;
  args(): string[];
  stdin(): string;
  pid(): number;
}

async function stubAgent(stream: string[], then = "exit 0"): Promise<StubAgent> {
  const dir = await temp.make("refine-turn-agent-");
  const command = join(dir, "claude");
  await writeFile(join(dir, "stream.jsonl"), `${stream.join("\n")}\n`);
  await writeFile(
    command,
    [
      "#!/bin/sh",
      `echo $$ > '${dir}/pid'`,
      `printf '%s\\n' "$@" > '${dir}/args'`,
      `cat > '${dir}/stdin'`,
      `cat '${dir}/stream.jsonl'`,
      then,
      "",
    ].join("\n"),
  );
  await chmod(command, 0o755);
  return {
    command,
    args: () => readFileSync(join(dir, "args"), "utf8").trimEnd().split("\n"),
    stdin: () => readFileSync(join(dir, "stdin"), "utf8"),
    pid: () => Number(readFileSync(join(dir, "pid"), "utf8").trim()),
  };
}

function cli(cwd: string, agent: StubAgent | null, stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  const env: CliEnv = {
    cwd,
    factoryRoot: FACTORY_ROOT,
    clock: new FakeClock("2026-11-07T10:43:00.000Z"),
    github: () => new FakeGitHub([{ number: 42, title: "Saved searches", body: "" }]),
    runner: () => new FakeWorkerRunner(),
    verifier: () => new FakeVerifier(),
    notifier: new FakeNotifier(),
    credentials: {},
    docker: async () => null,
    gh: async () => null,
    claudeSession: async () => null,
    originHead: async () => null,
    push: async () => null,
    launch: async () => 0,
    images: new FakeImageDocker(),
    signal: new AbortController().signal,
    readStdin: async () => stdin,
    ...(agent !== null ? { agentCommand: () => agent.command } : {}),
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };
  return { env, out, err };
}

const conversation = (repoDir: string) => join(repoDir, ".factory", "web", "refinement-42");
const TURN = ["refine", "42", "--turn", "--refinement-agent", "claude-code:sonnet"];

async function writeSession(repoDir: string): Promise<void> {
  await mkdir(conversation(repoDir), { recursive: true });
  await writeFile(join(conversation(repoDir), "session.json"), JSON.stringify({ session: SESSION }));
}

describe("factory refine <n> --turn", () => {
  it("should refuse an OpenCode refinement with the reason, before any worktree or agent", async () => {
    const repoDir = await targetRepo();
    const agent = await stubAgent(loadedStream);
    const { env, err } = cli(repoDir, agent);

    expect(await main(["refine", "42", "--turn", "--refinement-agent", "opencode:opencode-go/kimi-k3"], env)).toBe(1);

    expect(err.join("\n")).toBe(
      "factory: opencode has no turn of the refinement, so it cannot refine from the web: the refinement stays on Claude Code until a real run proves its skill with opencode (ADR 0003)",
    );
    expect(existsSync(join(repoDir, ".factory", "worktrees"))).toBe(false);
    expect(existsSync(join(agent.command, "..", "args"))).toBe(false);
  });

  it("should start the refinement skill in the worktree in the first turn, and record the session and the stream of the turn", async () => {
    const repoDir = await targetRepo();
    const agent = await stubAgent(loadedStream);
    const { env } = cli(repoDir, agent);

    expect(await main(TURN, env)).toBe(0);

    expect(agent.args().slice(-2)).toEqual(["-p", "/factory:refine 42"]);
    expect(agent.stdin()).toBe("");
    expect(JSON.parse(await readFile(join(conversation(repoDir), "session.json"), "utf8"))).toEqual({ session: SESSION });
    const turns = (await readdir(join(conversation(repoDir), "turns"))).filter((name) => name.endsWith(".jsonl"));
    expect(turns).toHaveLength(1);
    expect((await readFile(join(conversation(repoDir), "turns", turns[0] ?? ""), "utf8")).trim().split("\n")).toEqual(loadedStream);
  });

  it("should resume the recorded session in the next turn and pass the answer on stdin, never as an argument", async () => {
    const repoDir = await targetRepo();
    await writeSession(repoDir);
    const agent = await stubAgent(loadedStream);
    const { env } = cli(repoDir, agent, ANSWER);

    expect(await main(TURN, env)).toBe(0);

    expect(agent.stdin()).toBe(ANSWER);
    expect(agent.args()).toContain(SESSION);
    expect(agent.args().join("\n")).not.toContain("saved searches per user");
  });

  it("should refuse a next turn with no answer, because the agent would have nothing to read", async () => {
    const repoDir = await targetRepo();
    await writeSession(repoDir);
    const agent = await stubAgent(loadedStream);
    const { env, err } = cli(repoDir, agent, "  \n");

    expect(await main(TURN, env)).toBe(1);

    expect(err.join("\n")).toContain("the answer is empty");
    expect(existsSync(join(agent.command, "..", "args"))).toBe(false);
  });

  it("should refuse an answer in the first turn, which only starts the skill, so no answer is lost", async () => {
    const repoDir = await targetRepo();
    const agent = await stubAgent(loadedStream);
    const { env, err } = cli(repoDir, agent, ANSWER);

    expect(await main(TURN, env)).toBe(1);

    expect(err.join("\n")).toContain("the first turn of the refinement of #42 starts its skill and takes no answer");
  });

  it("should stop the agent and fail the turn when the list of allowed tools did not load", async () => {
    const repoDir = await targetRepo();
    const agent = await stubAgent([defaultInit], "exec sleep 30");
    const { env, err } = cli(repoDir, agent);

    const started = Date.now();
    expect(await main(TURN, env)).toBe(1);
    pids.push(agent.pid());

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(isAlive(agent.pid())).toBe(false);
    expect(err.join("\n")).toContain("factory: the agent of the refinement did not load the allowed tools");
    expect(existsSync(join(conversation(repoDir), "session.json"))).toBe(false);
  });

  it("should fail the turn when the agent ends with no init event, because nothing shows the list loaded", async () => {
    const repoDir = await targetRepo();
    const agent = await stubAgent(realStream.slice(1));
    const { env, err } = cli(repoDir, agent);

    expect(await main(TURN, env)).toBe(1);

    expect(err.join("\n")).toContain("the agent of the refinement acted before it reported its tools");
  });

  it("should refuse a second turn of the same issue while one is in progress, because two turns would corrupt the session", async () => {
    const repoDir = await targetRepo();
    const other = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    if (other.pid === undefined) throw new Error("sleep did not start");
    pids.push(other.pid);
    await writeAction(repoDir, "2026-11-07T10-42-00-000Z-refine-42", other.pid);
    const agent = await stubAgent(loadedStream);
    const { env, err } = cli(repoDir, agent);

    expect(await main(TURN, env)).toBe(1);

    expect(err.join("\n")).toBe(
      `factory: a turn of the refinement of #42 is in progress since ${clockMinutes(new Date("2026-11-07T10:42:00.000Z"))} (2026-11-07T10-42-00-000Z-refine-42); wait for it to end or stop it`,
    );
    expect(existsSync(join(agent.command, "..", "args"))).toBe(false);
  });

  it("should not count its own web action as a turn in progress", async () => {
    const repoDir = await targetRepo();
    const id = "2026-11-07T10-43-00-000Z-refine-42";
    await writeAction(repoDir, id, process.pid);
    const agent = await stubAgent(loadedStream);
    const { env } = cli(repoDir, agent);

    expect(await main([...TURN, "--web-action", id], env)).toBe(0);
    expect(await readdir(join(conversation(repoDir), "turns"))).toEqual([`${id}.jsonl`]);
  });
});

async function writeAction(repoDir: string, id: string, pid: number): Promise<void> {
  const dir = join(repoDir, ".factory", "web", id);
  await mkdir(dir, { recursive: true });
  const record = {
    version: 1,
    id,
    command: "refine",
    args: ["refine", "42", "--turn"],
    issue: 42,
    startedAt: "2026-11-07T10:42:00.000Z",
    pid,
    processStart: await processStartTime(pid),
  };
  await writeFile(join(dir, "action.json"), JSON.stringify(record));
}
