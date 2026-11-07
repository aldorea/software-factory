import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, type CliEnv } from "../../src/cli/main.ts";
import { readSession, readTurns } from "../../src/commands/conversation.ts";
import { adapterFor } from "../../src/workers/agents.ts";
import { execOk } from "../../src/workers/sh.ts";
import { FakeGitHub } from "../fakes/github.ts";
import { FakeImageDocker } from "../fakes/image-docker.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeVerifier } from "../fakes/verifier.ts";
import { FakeWorkerRunner } from "../fakes/worker-runner.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

const FACTORY_ROOT = join(import.meta.dirname, "..", "..");
const FIXTURES = join(import.meta.dirname, "..", "workers", "fixtures");
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";

async function git(dir: string, ...args: string[]): Promise<void> {
  await execOk("git", ["-C", dir, ...args]);
}

async function targetRepo(): Promise<string> {
  const dir = await temp.make("refine-turn-real-");
  await execOk("git", ["init", "-q", "-b", "main", dir]);
  await git(dir, "config", "user.name", "t");
  await git(dir, "config", "user.email", "t@t");
  await writeFile(join(dir, "README.md"), "# target\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
  const remoteDir = await temp.make("refine-turn-real-remote-");
  await execOk("git", ["init", "-q", "--bare", "-b", "main", remoteDir]);
  await git(dir, "remote", "add", "origin", remoteDir);
  await git(dir, "push", "-q", "origin", "main");
  await git(dir, "remote", "set-head", "origin", "--auto");
  return dir;
}

function cli(cwd: string, answer: string): { env: CliEnv; err: string[] } {
  const err: string[] = [];
  const env: CliEnv = {
    cwd,
    factoryRoot: FACTORY_ROOT,
    clock: { now: () => new Date() },
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
    readStdin: async () => answer,
    out: () => undefined,
    err: (text) => err.push(text),
  };
  return { env, err };
}

const TURN = ["refine", "42", "--turn", "--refinement-agent", "claude-code:sonnet"];

describe.skipIf(token === "")("a real turn of the refinement with Claude Code", () => {
  it("should start /factory:refine 42 in the first turn and keep its context in the second, capturing both streams as fixtures", async () => {
    const repoDir = await targetRepo();

    const first = cli(repoDir, "");
    expect(await main(TURN, first.env), first.err.join("\n")).toBe(0);
    const session = await readSession(repoDir, 42);
    expect(session).not.toBeNull();

    const second = cli(repoDir, "Before anything else: which issue number are you refining? Answer with the number only.");
    expect(await main(TURN, second.env), second.err.join("\n")).toBe(0);

    const turns = await readTurns(repoDir, 42);
    expect(turns).toHaveLength(2);
    const transcript = adapterFor("claude-code").refinementTurn?.transcript(turns[1]?.lines ?? []) ?? [];
    expect(transcript.filter((message) => message.kind === "text").map((message) => message.text).join("\n")).toContain("42");
    await writeFile(join(FIXTURES, "claude-refinement-turn-1.jsonl"), `${turns[0]?.lines.join("\n")}\n`);
    await writeFile(join(FIXTURES, "claude-refinement-turn-2.jsonl"), `${turns[1]?.lines.join("\n")}\n`);
  }, 600_000);
});
