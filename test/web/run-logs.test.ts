import { execFile } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { handleRequest } from "../../src/web/handler.ts";
import { aRun, repoWithRuns, request, temp } from "./run-page-helpers.ts";

afterEach(() => temp.removeAll());

async function repoWithLog(files: Record<string, string> = {}) {
  const log = aRun(0);
  const dir = await repoWithRuns([{ log }]);
  const runDir = join(dir, ".factory", "logs", log.runId);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(runDir, name, ".."), { recursive: true });
    await writeFile(join(runDir, name), content);
  }
  return { dir, runDir, runId: log.runId };
}

describe("the raw logs of a run", () => {
  it("should serve a file of the run folder as plain text", async () => {
    const { dir, runId } = await repoWithLog({ "S1-attempt-1.jsonl": '{"type":"result"}\n' });

    const response = await handleRequest(request(dir, `/runs/${runId}/S1-attempt-1.jsonl`));

    expect(response.status).toBe(200);
    expect(response.contentType).toBe("text/plain; charset=utf-8");
    expect(response.body).toBe('{"type":"result"}\n');
  });

  it("should serve a file in a subfolder of the run folder", async () => {
    const { dir, runId } = await repoWithLog({ "output/final/check-1-test.log": "1 test failed\n" });

    const response = await handleRequest(request(dir, `/runs/${runId}/output/final/check-1-test.log`));

    expect(response.status).toBe(200);
    expect(response.body).toBe("1 test failed\n");
  });

  it("should serve a log that contains HTML as text, so the browser shows it and does not run it", async () => {
    const { dir, runId } = await repoWithLog({ "page.log": "<script>alert(1)</script>" });

    const response = await handleRequest(request(dir, `/runs/${runId}/page.log`));

    expect(response.contentType).toMatch(/^text\/plain/);
    expect(response.body).toBe("<script>alert(1)</script>");
  });
});

const SECRET = "the-secret-outside-the-run";

async function repoWithSecrets() {
  const repo = await repoWithLog({ "S1-attempt-1.jsonl": "inside\n", "output/final/check-1-test.log": "inside\n" });
  const outsideLogs = join(repo.dir, ".factory", "logs", "other-run.log");
  const secrets = [join(repo.dir, "secret.txt"), join(repo.dir, ".factory", "secret.txt"), outsideLogs];
  for (const file of secrets) await writeFile(file, SECRET);
  const sibling = aRun(1);
  await mkdir(join(repo.dir, ".factory", "logs", sibling.runId), { recursive: true });
  await writeFile(join(repo.dir, ".factory", "logs", sibling.runId, "sibling.log"), SECRET);
  return { ...repo, secretFile: secrets[0] as string, siblingId: sibling.runId };
}

type Repo = Awaited<ReturnType<typeof repoWithSecrets>>;
type PathOf = (runId: string, repo: Repo) => string;

async function answerTo(path: PathOf) {
  const repo = await repoWithSecrets();
  return handleRequest(request(repo.dir, path(repo.runId, repo)));
}

describe("a path that leaves the run folder", () => {
  it.each<[string, PathOf]>([
    ["a dot-dot segment", (id) => `/runs/${id}/../../secret.txt`],
    ["a dot-dot segment in the middle", (id) => `/runs/${id}/output/../../../secret.txt`],
    ["an encoded dot-dot segment", (id) => `/runs/${id}/%2e%2e/%2e%2e/secret.txt`],
    ["an upper-case encoded dot-dot segment", (id) => `/runs/${id}/%2E%2E/%2E%2E/secret.txt`],
    ["an encoded slash", (id) => `/runs/${id}/..%2f..%2fsecret.txt`],
    ["a fully encoded traversal", (id) => `/runs/${id}/%2e%2e%2f%2e%2e%2fsecret.txt`],
    ["an encoded backslash", (id) => `/runs/${id}/..%5c..%5csecret.txt`],
    ["the folder of a sibling run", (id, repo) => `/runs/${id}/../${repo.siblingId}/sibling.log`],
    ["an empty segment that makes the path absolute", (id, repo) => `/runs/${id}/${repo.secretFile}`],
    ["an encoded absolute path", (id, repo) => `/runs/${id}/${encodeURIComponent(repo.secretFile)}`],
    ["a lone dot segment", (id) => `/runs/${id}/.`],
    ["a NUL byte", (id) => `/runs/${id}/S1-attempt-1.jsonl%00.txt`],
    ["a lone NUL byte", (id) => `/runs/${id}/%00`],
    ["a malformed escape", (id) => `/runs/${id}/%zz`],
  ])("should answer 404 for %s", async (_name, path) => {
    const response = await answerTo(path);

    expect(response.status).toBe(404);
    expect(response.contentType).toBe("text/html; charset=utf-8");
    expect(response.body).not.toContain(SECRET);
  });

  it.each<[string, PathOf]>([
    ["a directory", (id) => `/runs/${id}/output`],
    ["a directory with a trailing slash", (id) => `/runs/${id}/output/`],
    ["a nested directory", (id) => `/runs/${id}/output/final`],
    ["a file that does not exist", (id) => `/runs/${id}/missing.log`],
    ["a file below a file", (id) => `/runs/${id}/S1-attempt-1.jsonl/extra`],
  ])("should answer 404 for %s", async (_name, path) => {
    const response = await answerTo(path);

    expect(response.status).toBe(404);
  });

  it("should answer 404 for a run ID that is not the format of a run ID", async () => {
    const { dir } = await repoWithSecrets();

    const response = await handleRequest(request(dir, "/runs/nope/S1-attempt-1.jsonl"));

    expect(response.status).toBe(404);
  });

  it("should answer 404 for a run ID that has the right format and no folder", async () => {
    const { dir } = await repoWithSecrets();

    const response = await handleRequest(request(dir, "/runs/9-2026-01-01T00-00-00-000Z/S1-attempt-1.jsonl"));

    expect(response.status).toBe(404);
  });

  it("should answer 405 to a method other than GET, as for every page", async () => {
    const { dir, runId } = await repoWithSecrets();

    const response = await handleRequest(request(dir, `/runs/${runId}/S1-attempt-1.jsonl`, { method: "POST" }));

    expect(response.status).toBe(405);
  });

  it("should answer 403 to a Host that is not the server, as for every page", async () => {
    const { dir, runId } = await repoWithSecrets();

    const response = await handleRequest(request(dir, `/runs/${runId}/S1-attempt-1.jsonl`, { host: "evil.example:7433" }));

    expect(response.status).toBe(403);
  });
});

describe("a symlink in the run folder", () => {
  it("should answer 404 when a file symlink points to a file outside the run", async () => {
    const { dir, runDir, runId, secretFile } = await repoWithSecrets();
    await symlink(secretFile, join(runDir, "leak.log"));

    const response = await handleRequest(request(dir, `/runs/${runId}/leak.log`));

    expect(response.status).toBe(404);
    expect(response.body).not.toContain(SECRET);
  });

  it("should answer 404 when a relative symlink climbs out of the run", async () => {
    const { dir, runDir, runId } = await repoWithSecrets();
    await symlink("../../../secret.txt", join(runDir, "climb.log"));

    const response = await handleRequest(request(dir, `/runs/${runId}/climb.log`));

    expect(response.status).toBe(404);
    expect(response.body).not.toContain(SECRET);
  });

  it("should answer 404 for a file below a folder symlink that points outside the run", async () => {
    const { dir, runDir, runId } = await repoWithSecrets();
    await symlink(join(dir, ".factory"), join(runDir, "linked"));

    const response = await handleRequest(request(dir, `/runs/${runId}/linked/secret.txt`));

    expect(response.status).toBe(404);
    expect(response.body).not.toContain(SECRET);
  });

  it("should answer 404 for a symlink to the folder of a sibling run", async () => {
    const { dir, runDir, runId, siblingId } = await repoWithSecrets();
    await symlink(join(dir, ".factory", "logs", siblingId), join(runDir, "sibling"));

    const response = await handleRequest(request(dir, `/runs/${runId}/sibling/sibling.log`));

    expect(response.status).toBe(404);
    expect(response.body).not.toContain(SECRET);
  });

  it("should answer 404 for a symlink that points nowhere", async () => {
    const { dir, runDir, runId } = await repoWithSecrets();
    await symlink(join(dir, "missing"), join(runDir, "dangling.log"));

    expect((await handleRequest(request(dir, `/runs/${runId}/dangling.log`))).status).toBe(404);
  });

  it("should answer 404 for a symlink loop", async () => {
    const { dir, runDir, runId } = await repoWithSecrets();
    await symlink(join(runDir, "b.log"), join(runDir, "a.log"));
    await symlink(join(runDir, "a.log"), join(runDir, "b.log"));

    expect((await handleRequest(request(dir, `/runs/${runId}/a.log`))).status).toBe(404);
  });

  it("should serve a symlink that points to another file inside the run, because its real path is inside", async () => {
    const { dir, runDir, runId } = await repoWithSecrets();
    await symlink(join(runDir, "S1-attempt-1.jsonl"), join(runDir, "latest.jsonl"));

    const response = await handleRequest(request(dir, `/runs/${runId}/latest.jsonl`));

    expect(response.status).toBe(200);
    expect(response.body).toBe("inside\n");
  });
});

describe("a file in the run folder that is not a regular file", () => {
  it("should answer 404 for a named pipe, so the server never blocks on it", async () => {
    const { dir, runDir, runId } = await repoWithSecrets();
    await promisify(execFile)("mkfifo", [join(runDir, "pipe.log")]);

    const response = await handleRequest(request(dir, `/runs/${runId}/pipe.log`));

    expect(response.status).toBe(404);
  });
});
