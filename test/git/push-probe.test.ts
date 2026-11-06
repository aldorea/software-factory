import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { githubRepoOfRemote, pushProblem } from "../../src/git/push-probe.ts";
import { execOk } from "../../src/workers/sh.ts";
import { FakeGitHub } from "../fakes/github.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
const servers: Server[] = [];

afterEach(async () => {
  await temp.removeAll();
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => { server.close(done); server.closeAllConnections(); })));
});

async function repoWithOrigin(origin: string | null): Promise<string> {
  const repo = await temp.make("push-probe-repo-");
  await execOk("git", ["init", "-q", "-b", "main", repo]);
  if (origin !== null) await execOk("git", ["-C", repo, "remote", "add", "origin", origin]);
  return repo;
}

async function bareRepo(): Promise<string> {
  const bare = await temp.make("push-probe-bare-");
  await execOk("git", ["init", "-q", "--bare", "-b", "main", bare]);
  return bare;
}

async function listeningServer(handler: Parameters<typeof createServer>[1]): Promise<{ url: string; server: Server }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/aldorea/askwell.git`, server };
}

const ORIGIN = "git@github.com:aldorea/askwell.git";
const UNREACHABLE = "cannot reach github.com/aldorea/askwell with the gh session";
const UNREACHABLE_BECAUSE = /^cannot reach github\.com\/aldorea\/askwell with the gh session: \S/;

describe("githubRepoOfRemote", () => {
  it.each([
    ["git@github.com:aldorea/askwell.git", { owner: "aldorea", repo: "askwell" }],
    ["git@github.com:aldorea/askwell", { owner: "aldorea", repo: "askwell" }],
    ["https://github.com/aldorea/askwell.git", { owner: "aldorea", repo: "askwell" }],
    ["https://github.com/aldorea/askwell/", { owner: "aldorea", repo: "askwell" }],
    ["https://user@github.com/aldorea/askwell.git", { owner: "aldorea", repo: "askwell" }],
    ["ssh://git@github.com/aldorea/askwell.git", { owner: "aldorea", repo: "askwell" }],
    ["ssh://git@github.com:22/aldorea/askwell.git", { owner: "aldorea", repo: "askwell" }],
    ["git://github.com/aldorea/askwell.git", { owner: "aldorea", repo: "askwell" }],
  ])("should read the owner and the repo of %s", (remote, expected) => {
    expect(githubRepoOfRemote(remote)).toEqual(expected);
  });

  it.each([
    "git@gitlab.com:aldorea/askwell.git",
    "https://github.example.com/aldorea/askwell.git",
    "https://notgithub.com/aldorea/askwell.git",
    "https://github.com/aldorea",
    "https://github.com/aldorea/askwell/pulls",
    "/srv/git/askwell.git",
    "../askwell.git",
    "file:///srv/git/askwell.git",
    "",
  ])("should say that %j is not a GitHub repo", (remote) => {
    expect(githubRepoOfRemote(remote)).toBeNull();
  });
});

describe("pushProblem", () => {
  it("should find no problem when the destination answers ls-remote", async () => {
    const repo = await repoWithOrigin(ORIGIN);
    const github = new FakeGitHub([], await bareRepo());

    expect(await pushProblem(repo, github)).toBeNull();
  });

  it("should fail closed with the reason when origin is not a GitHub repo, without asking the destination", async () => {
    const repo = await repoWithOrigin("git@gitlab.com:aldorea/askwell.git");

    expect(await pushProblem(repo, new FakeGitHub([], await bareRepo()))).toBe(
      "origin is not a GitHub repo: git@gitlab.com:aldorea/askwell.git",
    );
  });

  it("should fail closed when origin is a local path, because a push there would go somewhere else than the PR", async () => {
    const repo = await repoWithOrigin(await bareRepo());

    expect(await pushProblem(repo, new FakeGitHub([], await bareRepo()))).toMatch(/^origin is not a GitHub repo: \//);
  });

  it("should fail closed when the repo has no origin", async () => {
    const repo = await repoWithOrigin(null);

    expect(await pushProblem(repo, new FakeGitHub([], await bareRepo()))).toBe("the repo has no origin remote");
  });

  it("should say that it cannot reach the repo when the connection is refused", async () => {
    const repo = await repoWithOrigin(ORIGIN);
    const { url, server } = await listeningServer(() => undefined);
    await new Promise((done) => server.close(done));

    const problem = await pushProblem(repo, new FakeGitHub([], url));

    expect(problem).toMatch(UNREACHABLE_BECAUSE);
    expect(problem).toContain("127.0.0.1");
  });

  it("should say that it cannot reach the repo when gh cannot name the destination", async () => {
    const repo = await repoWithOrigin(ORIGIN);

    expect(await pushProblem(repo, new FakeGitHub([]))).toBe(`${UNREACHABLE}: FakeGitHub has no bare repo to push to`);
  });

  it("should name the repo the push goes to, not the one of origin, and give the reason of git after it", async () => {
    const repo = await repoWithOrigin(ORIGIN);
    const { url, server } = await listeningServer(() => undefined);
    await new Promise((done) => server.close(done));
    const github = new FakeGitHub([], "https://github.com/other/fork.git");
    github.gitArgs = ["-c", `url.${url.replace(/aldorea\/askwell\.git$/, "")}.insteadOf=https://github.com/`];

    const problem = await pushProblem(repo, github);

    expect(problem).toMatch(/^cannot reach github\.com\/other\/fork with the gh session: .*127\.0\.0\.1/);
    expect(problem).not.toContain("askwell");
  });

  it("should not leak a credential of the url of the destination in the reason", async () => {
    const repo = await repoWithOrigin(ORIGIN);
    const { url, server } = await listeningServer(() => undefined);
    await new Promise((done) => server.close(done));

    const problem = await pushProblem(repo, new FakeGitHub([], url.replace("http://", "http://gh-user:s3cr3t-token@")));

    expect(problem).toMatch(UNREACHABLE_BECAUSE);
    expect(problem).not.toContain("s3cr3t-token");
  });

  it("should fail at once instead of waiting for a credential when the server answers 401", async () => {
    const repo = await repoWithOrigin(ORIGIN);
    const { url } = await listeningServer((_request, response) => {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="github"' });
      response.end();
    });
    const started = Date.now();

    const problem = await pushProblem(repo, new FakeGitHub([], url));

    expect(problem).toMatch(UNREACHABLE_BECAUSE);
    expect(problem).toContain("terminal prompts disabled");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("should give up when the server never answers, instead of waiting for ever", async () => {
    const repo = await repoWithOrigin(ORIGIN);
    const { url } = await listeningServer(() => undefined);
    const started = Date.now();

    const problem = await pushProblem(repo, new FakeGitHub([], url), { timeoutMs: 500 });

    expect(problem).toMatch(UNREACHABLE_BECAUSE);
    expect(problem).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
