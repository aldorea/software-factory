import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fetchBranch, lsRemote, pushBranch, pushBranchAttempt } from "../../src/git/transport.ts";
import type { PushDestination } from "../../src/github/github.ts";
import { execOk } from "../../src/workers/sh.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
const servers: Server[] = [];

afterEach(async () => {
  await temp.removeAll();
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function repoWithBranch(): Promise<string> {
  const repo = await temp.make("transport-repo-");
  await execOk("git", ["init", "-q", "-b", "main", repo]);
  await execOk("git", ["-C", repo, "config", "user.name", "t"]);
  await execOk("git", ["-C", repo, "config", "user.email", "t@t"]);
  await execOk("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
  return repo;
}

async function bareRepo(): Promise<string> {
  const bare = await temp.make("transport-bare-");
  await execOk("git", ["init", "-q", "--bare", "-b", "main", bare]);
  return bare;
}

async function unauthorizedServer(seen: IncomingMessage[] = []): Promise<string> {
  const server = createServer((request, response) => {
    seen.push(request);
    response.writeHead(401, { "WWW-Authenticate": 'Basic realm="github"' });
    response.end();
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/aldorea/repo.git`;
}

async function script(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

describe("pushBranch", () => {
  it("should push the branch to the url of the destination, whatever the remotes of the repo say", async () => {
    const repo = await repoWithBranch();
    const bare = await bareRepo();
    await execOk("git", ["-C", repo, "remote", "add", "origin", "/nonexistent/origin.git"]);
    const destination: PushDestination = { url: bare, gitArgs: [] };

    await pushBranch(repo, destination, "main");

    expect(await execOk("git", ["-C", bare, "rev-parse", "main"])).toBe(await execOk("git", ["-C", repo, "rev-parse", "main"]));
  });

  it("should not touch the remotes or the configuration of the repo", async () => {
    const repo = await repoWithBranch();
    const bare = await bareRepo();
    await execOk("git", ["-C", repo, "remote", "add", "origin", "git@github.com:aldorea/repo.git"]);
    const before = await readFile(join(repo, ".git", "config"), "utf8");

    await pushBranch(repo, { url: bare, gitArgs: ["-c", "credential.helper="] }, "main");

    expect(await readFile(join(repo, ".git", "config"), "utf8")).toBe(before);
  });

  it("should fail with the reason of git when the push is rejected", async () => {
    const repo = await repoWithBranch();

    await expect(pushBranch(repo, { url: "/nonexistent/origin.git", gitArgs: [] }, "main")).rejects.toThrow(
      /does not appear to be a git repository/,
    );
  });

  it("should fail at once with terminal prompts disabled when the server asks for a credential nobody gave, instead of waiting for input", async () => {
    const repo = await repoWithBranch();
    const url = await unauthorizedServer();
    const started = Date.now();

    const attempt = await pushBranchAttempt(repo, { url, gitArgs: ["-c", "credential.helper="] }, "main");

    expect(attempt.exitCode).not.toBe(0);
    expect(attempt.stderr).toContain("terminal prompts disabled");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("should answer the credential request with the helper of the destination alone, with GIT_TERMINAL_PROMPT=0 and GCM_INTERACTIVE=never in its environment", async () => {
    const repo = await repoWithBranch();
    const scripts = await temp.make("transport-helpers-");
    const record = join(scripts, "env.txt");
    const staleRecord = join(scripts, "stale.txt");
    const helper = await script(
      scripts,
      "gh-helper.sh",
      `if [ "$1" = get ]; then\n  echo "$GIT_TERMINAL_PROMPT $GCM_INTERACTIVE" > ${record}\n  echo username=gh-user\n  echo password=gh-token\nfi`,
    );
    const stale = await script(
      scripts,
      "stale-helper.sh",
      `if [ "$1" = get ]; then\n  echo called > ${staleRecord}\n  echo username=stale\n  echo password=stale\nfi`,
    );
    await execOk("git", ["-C", repo, "config", "credential.helper", `!${stale}`]);
    const seen: IncomingMessage[] = [];
    const url = await unauthorizedServer(seen);

    await pushBranchAttempt(repo, { url, gitArgs: ["-c", "credential.helper=", "-c", `credential.helper=!${helper}`] }, "main");

    expect(await readFile(record, "utf8")).toBe("0 never\n");
    await expect(readFile(staleRecord, "utf8")).rejects.toThrow(/ENOENT/);
    const authorization = seen.map((request) => request.headers.authorization).find((value) => value !== undefined);
    expect(authorization).toBe(`Basic ${Buffer.from("gh-user:gh-token").toString("base64")}`);
  });
});

describe("fetchBranch", () => {
  it("should fetch the branch of the destination into FETCH_HEAD and tell whether it exists", async () => {
    const repo = await repoWithBranch();
    const bare = await bareRepo();
    const destination: PushDestination = { url: bare, gitArgs: [] };
    await pushBranch(repo, destination, "main");

    const missing = await fetchBranch(repo, destination, "absent");
    const found = await fetchBranch(repo, destination, "main");

    expect(found).toBe(true);
    expect(missing).toBe(false);
    expect((await execOk("git", ["-C", repo, "rev-parse", "FETCH_HEAD"])).trim()).toBe(
      (await execOk("git", ["-C", repo, "rev-parse", "main"])).trim(),
    );
  });
});

describe("lsRemote", () => {
  it("should list the refs of the destination whatever the remotes of the repo say", async () => {
    const repo = await repoWithBranch();
    const bare = await bareRepo();
    await execOk("git", ["-C", repo, "remote", "add", "origin", "/nonexistent/origin.git"]);
    const destination: PushDestination = { url: bare, gitArgs: [] };
    await pushBranch(repo, destination, "main");

    const listed = await lsRemote(repo, destination);

    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain((await execOk("git", ["-C", repo, "rev-parse", "main"])).trim());
  });

  it("should exit 0 for an empty destination, because reaching it is what the check asks", async () => {
    const repo = await repoWithBranch();

    expect((await lsRemote(repo, { url: await bareRepo(), gitArgs: [] })).exitCode).toBe(0);
  });

  it("should fail at once with terminal prompts disabled when the server asks for a credential nobody gave, instead of waiting for input", async () => {
    const repo = await repoWithBranch();
    const url = await unauthorizedServer();
    const started = Date.now();

    const listed = await lsRemote(repo, { url, gitArgs: ["-c", "credential.helper="] });

    expect(listed.exitCode).not.toBe(0);
    expect(listed.stderr).toContain("terminal prompts disabled");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("should answer the credential request with the helper of the destination alone, with GIT_TERMINAL_PROMPT=0 and GCM_INTERACTIVE=never in its environment", async () => {
    const repo = await repoWithBranch();
    const scripts = await temp.make("transport-ls-helpers-");
    const record = join(scripts, "env.txt");
    const staleRecord = join(scripts, "stale.txt");
    const helper = await script(
      scripts,
      "gh-helper.sh",
      `if [ "$1" = get ]; then\n  echo "$GIT_TERMINAL_PROMPT $GCM_INTERACTIVE" > ${record}\n  echo username=gh-user\n  echo password=gh-token\nfi`,
    );
    const stale = await script(
      scripts,
      "stale-helper.sh",
      `if [ "$1" = get ]; then\n  echo called > ${staleRecord}\n  echo username=stale\n  echo password=stale\nfi`,
    );
    await execOk("git", ["-C", repo, "config", "credential.helper", `!${stale}`]);
    const seen: IncomingMessage[] = [];
    const url = await unauthorizedServer(seen);

    await lsRemote(repo, { url, gitArgs: ["-c", "credential.helper=", "-c", `credential.helper=!${helper}`] });

    expect(await readFile(record, "utf8")).toBe("0 never\n");
    await expect(readFile(staleRecord, "utf8")).rejects.toThrow(/ENOENT/);
    const authorization = seen.map((request) => request.headers.authorization).find((value) => value !== undefined);
    expect(authorization).toBe(`Basic ${Buffer.from("gh-user:gh-token").toString("base64")}`);
  });

  it("should stop waiting for a server that never answers after the timeout and report a failure", async () => {
    const repo = await repoWithBranch();
    const silent = createServer(() => undefined);
    servers.push(silent);
    await new Promise<void>((ready) => silent.listen(0, "127.0.0.1", ready));
    const url = `http://127.0.0.1:${(silent.address() as AddressInfo).port}/aldorea/repo.git`;
    const started = Date.now();

    const listed = await lsRemote(repo, { url, gitArgs: [] }, { timeoutMs: 500 });

    expect(listed.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
