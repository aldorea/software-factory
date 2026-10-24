import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DockerWorkerRunner } from "../../src/workers/docker-runner.ts";
import { execOk } from "../../src/workers/sh.ts";
import type { Worker, WorkerSpec } from "../../src/workers/types.ts";
import { tempDirs } from "../temp-dirs.ts";

const IMAGE = "software-factory/worker:dev";
const CLAUDE_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const OPENCODE_KEY = process.env.OPENCODE_API_KEY;
const identity = {
  GIT_AUTHOR_NAME: "factory",
  GIT_AUTHOR_EMAIL: "factory@localhost",
  GIT_COMMITTER_NAME: "factory",
  GIT_COMMITTER_EMAIL: "factory@localhost",
};

async function toyRepo(): Promise<string> {
  const dir = await temp.make("toy-repo-");
  await execOk("git", ["init", "-q", "-b", "main", dir]);
  await writeFile(join(dir, "README.md"), "# toy\n");
  await writeFile(join(dir, ".gitignore"), ".factory/\n");
  await execOk("git", ["-C", dir, "add", "."]);
  await execOk("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
  return dir;
}

async function spec(id: string, overrides: Partial<WorkerSpec> = {}): Promise<WorkerSpec> {
  const repoDir = await toyRepo();
  return {
    id,
    repoDir,
    baseRef: "main",
    branch: `factory/${id}`,
    image: IMAGE,
    env: { ...identity, FACTORY_MARKER: "present" },
    logDir: join(repoDir, ".factory", "logs"),
    ...overrides,
  };
}

const open: Worker[] = [];
const temp = tempDirs();
afterEach(async ({ task }) => {
  while (open.length > 0) await open.pop()?.close();
  if (task.result?.state === "fail") temp.keepAll();
  else await temp.removeAll();
});

describe.skipIf(!process.env.FACTORY_DOCKER_TESTS)("DockerWorkerRunner", { timeout: 360_000 }, () => {
  const runner = new DockerWorkerRunner();

  it("should run git inside the container on the worker branch, as the host user", async () => {
    const worker = await runner.start(await spec("git-inside"));
    open.push(worker);

    const branch = await worker.exec("git rev-parse --abbrev-ref HEAD");
    expect(branch).toMatchObject({ exitCode: 0, stdout: "factory/git-inside\n" });
    const uid = await worker.exec("id -u");
    expect(uid.stdout.trim()).toBe(String(process.getuid?.()));
  });

  it("should pass only the given environment", async () => {
    const worker = await runner.start(await spec("env-only"));
    open.push(worker);

    const env = await worker.exec("env");
    expect(env.stdout).toContain("FACTORY_MARKER=present");
    expect(env.stdout).not.toMatch(/^(GH_TOKEN|GITHUB_TOKEN|ANTHROPIC_API_KEY|SSH_AUTH_SOCK)=/m);
    const ssh = await worker.exec("test -e /home/agent/.ssh");
    expect(ssh.exitCode).not.toBe(0);
  });

  it("should collect the commits made in the container and remove a clean worktree", async () => {
    const s = await spec("commits");
    const worker = await runner.start(s);

    const commit = await worker.exec("echo hi > hello.txt && git add hello.txt && git commit -q -m hello");
    expect(commit.exitCode).toBe(0);
    const commits = await worker.commits();
    expect(commits).toHaveLength(1);

    const closed = await worker.close();
    expect(closed.preservedWorktreePath).toBeUndefined();
    expect(existsSync(worker.worktreePath)).toBe(false);
    const onHost = await execOk("git", ["-C", s.repoDir, "show", "factory/commits:hello.txt"]);
    expect(onHost).toBe("hi\n");
  });

  it("should keep a dirty worktree on close", async () => {
    const worker = await runner.start(await spec("dirty"));
    await worker.exec("echo wip > wip.txt");

    const closed = await worker.close();
    expect(closed.preservedWorktreePath).toBe(worker.worktreePath);
    expect(await readFile(join(worker.worktreePath, "wip.txt"), "utf8")).toBe("wip\n");
  });

  it("should report an agent error when Claude Code has no credentials", async () => {
    const worker = await runner.start(await spec("claude-no-auth"));
    open.push(worker);

    const attempt = await worker.attempt({ kind: "claude-code", model: "claude-haiku-5-5" }, "Reply OK.", {
      deadline: new Date(Date.now() + 60_000),
      idleTimeoutMs: 30_000,
    });
    expect(attempt.outcome.kind).toBe("agent-error");
    expect(existsSync(attempt.logPath)).toBe(true);
  });

  it("should remove a leftover container with the same name", async () => {
    await execOk("docker", ["run", "-d", "--name", "factory-leftover", IMAGE]);
    const worker = await runner.start(await spec("leftover"));
    open.push(worker);

    expect((await worker.exec("true")).exitCode).toBe(0);
  });

  it("should reuse the worktree that a dirty close kept", async () => {
    const s = await spec("reuse-dirty");
    const first = await runner.start(s);
    await first.exec("echo wip > wip.txt");
    await first.close();

    const second = await runner.start(s);
    open.push(second);
    expect(second.worktreePath).toBe(first.worktreePath);
    expect((await second.exec("cat wip.txt")).stdout).toBe("wip\n");
  });

  it("should resume a branch with no worktree and keep counting its commits from the base", async () => {
    const s = await spec("resume-branch");
    const first = await runner.start(s);
    await first.exec("echo one > one.txt && git add one.txt && git commit -q -m one");
    await first.close();
    expect(existsSync(first.worktreePath)).toBe(false);

    const second = await runner.start(s);
    open.push(second);
    expect((await second.exec("cat one.txt")).stdout).toBe("one\n");
    await second.exec("echo two > two.txt && git add two.txt && git commit -q -m two");
    expect(await second.commits()).toHaveLength(2);
  });

  it("should refuse a directory in the worktree path that git does not know, and leave it as it is", async () => {
    const s = await spec("orphan");
    const orphan = join(s.repoDir, ".factory", "worktrees", "orphan");
    await execOk("mkdir", ["-p", orphan]);
    await writeFile(join(orphan, "mine.txt"), "keep\n");

    await expect(runner.start(s)).rejects.toThrow(/does not know it as a worktree/);
    expect(await readFile(join(orphan, "mine.txt"), "utf8")).toBe("keep\n");
  });

  it("should apply the cpu and memory limits", async () => {
    const worker = await runner.start(await spec("resources", { cpus: "1", memory: "512m" }));
    open.push(worker);

    const inspect = await execOk("docker", [
      "inspect",
      "--format",
      "{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}",
      "factory-resources",
    ]);
    expect(inspect.trim()).toBe(`${1e9} ${512 * 1024 * 1024}`);
  });

  it.skipIf(!CLAUDE_TOKEN)("should run two Claude Code workers at once with one subscription token", async () => {
    const token = { CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN ?? "" };
    const workers = await Promise.all(
      ["claude-a", "claude-b"].map(async (id) =>
        runner.start(await spec(id, { env: { ...identity, ...token } })),
      ),
    );
    open.push(...workers);

    const attempts = await Promise.all(
      workers.map((worker) =>
        worker.attempt(
          { kind: "claude-code", model: "claude-haiku-5-5" },
          "Create a file hello.txt that contains the line hi, then commit it with the message hello. Do nothing else.",
          { deadline: new Date(Date.now() + 300_000), idleTimeoutMs: 120_000 },
        ),
      ),
    );

    for (const [i, attempt] of attempts.entries()) {
      expect(attempt.outcome, attempt.logPath).toMatchObject({ kind: "completed" });
      expect(attempt.usage.outputTokens).toBeGreaterThan(0);
      expect(attempt.plan?.windows.five_hour).toBeDefined();
      expect(await workers[i]?.commits()).toHaveLength(1);
    }
  });

  it.skipIf(!OPENCODE_KEY)("should run OpenCode Go in a container with the key in its environment", async () => {
    const worker = await runner.start(
      await spec("opencode-go", { env: { ...identity, OPENCODE_API_KEY: OPENCODE_KEY ?? "" } }),
    );
    open.push(worker);

    const attempt = await worker.attempt(
      { kind: "opencode", model: "opencode-go/beam-free" },
      "Reply with the single word OK.",
      { deadline: new Date(Date.now() + 120_000), idleTimeoutMs: 90_000 },
    );
    expect(attempt.outcome, attempt.logPath).toEqual({ kind: "completed", summary: "OK" });
  });
});
