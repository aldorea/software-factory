import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeRunLog, type RunLog } from "../../src/coordinator/run-log.ts";
import { handleRequest } from "../../src/web/handler.ts";
import { attemptRecord, subtaskRecord } from "../coordinator/run-log-fixtures.ts";
import { aRun, request, temp } from "./run-page-helpers.ts";

afterEach(() => temp.removeAll());

interface Page {
  dir: string;
  runDir: string;
  runId: string;
  body: string;
}

async function pageWith(build: (runDir: string) => Partial<RunLog>, files: Record<string, string> = {}): Promise<Page> {
  const dir = await temp.make("web-run-links-");
  const base = aRun(0);
  const runDir = join(dir, ".factory", "logs", base.runId);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(runDir, name)), { recursive: true });
    await writeFile(join(runDir, name), content);
  }
  const log = { ...base, ...build(runDir) };
  await writeRunLog(join(runDir, "run.json"), log);
  const response = await handleRequest(request(dir, `/runs/${base.runId}`));
  expect(response.status).toBe(200);
  return { dir, runDir, runId: base.runId, body: response.body };
}

function logHrefs(body: string): string[] {
  return [...body.matchAll(/<a href="(\/runs\/[^"]*)">/g)].map((match) => match[1] as string);
}

function itemsOf(body: string, className: string): string[] {
  return [...body.matchAll(new RegExp(`<li class="${className}">([\\s\\S]*?)</li>`, "g"))].map((match) => match[1] as string);
}

function hrefIn(html: string): string | undefined {
  return html.match(/<a href="(\/runs\/[^"]*)">/)?.[1];
}

async function open(page: Page, href: string) {
  return handleRequest(request(page.dir, href));
}

describe("the link of an attempt to its raw log", () => {
  it("should open from the attempt and serve the raw log as plain text", async () => {
    const page = await pageWith(
      (runDir) => ({
        subtasks: [subtaskRecord("S1", { attempts: [{ ...attemptRecord("claude-code", 10, 5), logPath: join(runDir, "S1-attempt-1.jsonl") }] })],
      }),
      { "S1-attempt-1.jsonl": '{"type":"assistant"}\n' },
    );

    const href = hrefIn(itemsOf(page.body, "attempt")[0] as string);
    expect(href).toBe(`/runs/${page.runId}/S1-attempt-1.jsonl`);
    const response = await open(page, href as string);

    expect(response.status).toBe(200);
    expect(response.contentType).toMatch(/^text\/plain/);
    expect(response.body).toBe('{"type":"assistant"}\n');
  });

  it("should link each attempt to its own log", async () => {
    const page = await pageWith(
      (runDir) => ({
        subtasks: [
          subtaskRecord("S1", {
            attempts: [
              { ...attemptRecord("claude-code", 10, 5), number: 1, logPath: join(runDir, "S1-attempt-1.jsonl") },
              { ...attemptRecord("claude-code", 10, 5), number: 2, logPath: join(runDir, "S1-attempt-2.jsonl") },
            ],
          }),
        ],
      }),
      { "S1-attempt-1.jsonl": "one", "S1-attempt-2.jsonl": "two" },
    );

    expect(itemsOf(page.body, "attempt").map(hrefIn)).toEqual([`/runs/${page.runId}/S1-attempt-1.jsonl`, `/runs/${page.runId}/S1-attempt-2.jsonl`]);
  });

  it("should encode a log name that has characters of a URL", async () => {
    const page = await pageWith(
      (runDir) => ({
        subtasks: [subtaskRecord("S1", { attempts: [{ ...attemptRecord("claude-code", 10, 5), logPath: join(runDir, "a b#c?.jsonl") }] })],
      }),
      { "a b#c?.jsonl": "odd name" },
    );

    const href = hrefIn(itemsOf(page.body, "attempt")[0] as string);
    expect(href).toBe(`/runs/${page.runId}/a%20b%23c%3F.jsonl`);
    expect((await open(page, href as string)).body).toBe("odd name");
  });
});

describe("a log path that is not inside the run folder", () => {
  it.each([
    ["an absolute path outside the run", () => "/logs/attempt.jsonl"],
    ["the absolute path of a system file", () => "/etc/passwd"],
    ["a relative path that climbs out of the run", () => "../../../secret.txt"],
    ["an absolute path that climbs out of the run", (runDir: string) => `${runDir}/../../../secret.txt`],
    ["the absolute path of a file in a sibling run", (runDir: string) => `${dirname(runDir)}/46-2026-10-25T08-00-00-000Z/a.log`],
    ["a path in a folder whose name starts like the run", (runDir: string) => `${runDir}-copy/a.log`],
    ["the run folder itself", (runDir: string) => runDir],
    ["an empty path", () => ""],
    ["a path with a NUL byte", (runDir: string) => `${runDir}/a.log\0.txt`],
  ])("should not be linked when it is %s", async (_name, logPath) => {
    const page = await pageWith(
      (runDir) => ({ subtasks: [subtaskRecord("S1", { attempts: [{ ...attemptRecord("claude-code", 10, 5), logPath: logPath(runDir) }] })] }),
      { "a.log": "inside" },
    );

    expect(itemsOf(page.body, "attempt")).toHaveLength(1);
    expect(logHrefs(page.body)).toEqual([]);
  });

  it("should not be linked when it goes through a symlink that points outside the run", async () => {
    const dir = await temp.make("web-run-links-outside-");
    await writeFile(join(dir, "secret.txt"), "the-secret");
    const base = aRun(0);
    const runDir = join(dir, ".factory", "logs", base.runId);
    await mkdir(runDir, { recursive: true });
    await symlink(join(dir, "secret.txt"), join(runDir, "leak.jsonl"));
    await symlink(dir, join(runDir, "linked"));
    const attempts = ["leak.jsonl", "linked/secret.txt"].map((name) => ({ ...attemptRecord("claude-code", 10, 5), logPath: join(runDir, name) }));
    await writeRunLog(join(runDir, "run.json"), { ...base, subtasks: [subtaskRecord("S1", { attempts })] });

    const response = await handleRequest(request(dir, `/runs/${base.runId}`));

    expect(response.status).toBe(200);
    expect(itemsOf(response.body, "attempt")).toHaveLength(2);
    expect(logHrefs(response.body)).toEqual([]);
  });

  it("should not be linked, and should not break the page, when run.json holds something that is not a string", async () => {
    const page = await pageWith(() => ({
      subtasks: [subtaskRecord("S1", { attempts: [{ ...attemptRecord("claude-code", 10, 5), logPath: 42 as unknown as string }] })],
    }));

    expect(itemsOf(page.body, "attempt")).toHaveLength(1);
    expect(logHrefs(page.body)).toEqual([]);
  });

  it("should not be linked when the file does not exist, so the page has no dead link", async () => {
    const page = await pageWith((runDir) => ({
      subtasks: [subtaskRecord("S1", { attempts: [{ ...attemptRecord("claude-code", 10, 5), logPath: join(runDir, "missing.jsonl") }] })],
    }));

    expect(logHrefs(page.body)).toEqual([]);
  });

  it("should still link the logs that are inside the run on the same page", async () => {
    const page = await pageWith(
      (runDir) => ({
        subtasks: [
          subtaskRecord("S1", {
            attempts: [
              { ...attemptRecord("claude-code", 10, 5), number: 1, logPath: "/logs/attempt.jsonl" },
              { ...attemptRecord("claude-code", 10, 5), number: 2, logPath: join(runDir, "S1-attempt-2.jsonl") },
            ],
          }),
        ],
      }),
      { "S1-attempt-2.jsonl": "two" },
    );

    expect(logHrefs(page.body)).toEqual([`/runs/${page.runId}/S1-attempt-2.jsonl`]);
  });
});

const FULL_OUTPUT = "error TS2322 at line 1\nerror TS2322 at line 2\nerror TS2322 at line 3\n";

describe("the link of a check or a criterion to its full output", () => {
  it("should open from a failed check of a gate with the complete output", async () => {
    const page = await pageWith(
      () => ({
        subtasks: [
          subtaskRecord("S1", {
            gate: {
              sha: "abc1234",
              accepted: false,
              reasons: [],
              criteria: [],
              verifier: [],
              checks: [
                { name: "typecheck", command: "pnpm typecheck", exitCode: 0, passed: true },
                { name: "test", command: "pnpm test", exitCode: 1, passed: false, firstError: "error TS2322", outputLog: "output/gate/check-2-test.log" },
              ],
            },
          }),
        ],
      }),
      { "output/gate/check-2-test.log": FULL_OUTPUT },
    );

    const [passed, failed] = itemsOf(page.body, "check");
    expect(hrefIn(passed as string)).toBeUndefined();
    const href = hrefIn(failed as string);
    expect(href).toBe(`/runs/${page.runId}/output/gate/check-2-test.log`);
    const response = await open(page, href as string);
    expect(response.status).toBe(200);
    expect(response.contentType).toMatch(/^text\/plain/);
    expect(response.body).toBe(FULL_OUTPUT);
  });

  it("should open from a failed criterion of a gate", async () => {
    const page = await pageWith(
      () => ({
        subtasks: [
          subtaskRecord("S1", {
            gate: {
              sha: "abc1234",
              accepted: false,
              reasons: [],
              checks: [],
              verifier: [],
              criteria: [{ id: "C1", evidence: "request", command: "curl x", exitCode: 22, passed: false, outputLog: "output/gate/C1.log" }],
            },
          }),
        ],
      }),
      { "output/gate/C1.log": "curl: (22) 404\n" },
    );

    const href = hrefIn(itemsOf(page.body, "criterion")[0] as string);
    expect(href).toBe(`/runs/${page.runId}/output/gate/C1.log`);
    expect((await open(page, href as string)).body).toBe("curl: (22) 404\n");
  });

  it("should open from a failed check and a failed criterion of the integrated verification", async () => {
    const page = await pageWith(
      () => ({
        verification: {
          sha: "9f8e7d6",
          passed: false,
          humanCriteria: [],
          checks: [{ name: "test", command: "pnpm test", exitCode: 1, passed: false, outputLog: "output/final/check-1-test.log" }],
          criteria: [{ id: "C2", evidence: "playwright", command: "playwright test", exitCode: 1, passed: false, outputLog: "output/final/C2.log" }],
        },
      }),
      { "output/final/check-1-test.log": "check output", "output/final/C2.log": "criterion output" },
    );

    expect((await open(page, hrefIn(itemsOf(page.body, "check")[0] as string) as string)).body).toBe("check output");
    expect((await open(page, hrefIn(itemsOf(page.body, "criterion")[0] as string) as string)).body).toBe("criterion output");
  });

  it("should open from a failed check of the integration-check block of the run", async () => {
    const page = await pageWith(
      () => ({
        result: "draft",
        block: {
          type: "integration-check",
          reason: "the checks failed on the integration branch",
          sha: "9f8e7d6",
          checks: [{ name: "test", command: "pnpm test", exitCode: 1, passed: false, outputLog: "output/final/check-1-test.log" }],
        },
      }),
      { "output/final/check-1-test.log": "block output" },
    );

    expect(logHrefs(page.body)).toEqual([`/runs/${page.runId}/output/final/check-1-test.log`]);
    expect((await open(page, logHrefs(page.body)[0] as string)).body).toBe("block output");
  });

  it("should not link a failed check whose full output was not kept", async () => {
    const page = await pageWith(() => ({
      verification: {
        sha: "9f8e7d6",
        passed: false,
        humanCriteria: [],
        criteria: [],
        checks: [{ name: "test", command: "pnpm test", exitCode: 1, passed: false, firstError: "boom" }],
      },
    }));

    expect(itemsOf(page.body, "check")).toHaveLength(1);
    expect(logHrefs(page.body)).toEqual([]);
  });

  it("should not link an output log that is outside the run folder", async () => {
    const page = await pageWith(() => ({
      verification: {
        sha: "9f8e7d6",
        passed: false,
        humanCriteria: [],
        criteria: [{ id: "C1", evidence: "request", command: "curl x", exitCode: 1, passed: false, outputLog: "../../../secret.txt" }],
        checks: [{ name: "test", command: "pnpm test", exitCode: 1, passed: false, outputLog: "/etc/passwd" }],
      },
    }));

    expect(itemsOf(page.body, "check")).toHaveLength(1);
    expect(itemsOf(page.body, "criterion")).toHaveLength(1);
    expect(logHrefs(page.body)).toEqual([]);
  });
});

describe("the link of the independent verifier and the acceptance tester to their logs", () => {
  it("should open from each verdict of the independent verifier", async () => {
    const page = await pageWith(
      (runDir) => ({
        subtasks: [
          subtaskRecord("S1", {
            gate: {
              sha: "abc1234",
              accepted: false,
              reasons: [],
              checks: [],
              criteria: [],
              verifier: [
                { id: "C1", verdict: "accept", logPath: join(runDir, "gate-verifier-C1.jsonl") },
                { id: "C2", verdict: "refute", reason: "the button is missing", logPath: join(runDir, "gate-verifier-C2.jsonl") },
                { id: "C3", verdict: "error", reason: "timed out", logPath: "/logs/outside.jsonl" },
              ],
            },
          }),
        ],
      }),
      { "gate-verifier-C1.jsonl": "accept log", "gate-verifier-C2.jsonl": "refute log" },
    );

    const [accepted, refuted, errored] = itemsOf(page.body, "verifier");
    expect((await open(page, hrefIn(accepted as string) as string)).body).toBe("accept log");
    expect((await open(page, hrefIn(refuted as string) as string)).body).toBe("refute log");
    expect(hrefIn(errored as string)).toBeUndefined();
  });

  it("should open the log of the acceptance tester, which run.json keeps relative to the run folder", async () => {
    const page = await pageWith(
      () => ({
        verification: {
          sha: "9f8e7d6",
          passed: true,
          checks: [],
          criteria: [],
          humanCriteria: [],
          tester: { agent: { agent: "claude-code", model: "claude-sonnet-4-5" }, verdicts: [], logPath: "final-tester.jsonl" },
        },
      }),
      { "final-tester.jsonl": "tester log" },
    );

    expect(logHrefs(page.body)).toEqual([`/runs/${page.runId}/final-tester.jsonl`]);
    const response = await open(page, logHrefs(page.body)[0] as string);
    expect(response.status).toBe(200);
    expect(response.contentType).toMatch(/^text\/plain/);
    expect(response.body).toBe("tester log");
  });

  it("should not link a tester log that is outside the run folder", async () => {
    const page = await pageWith(() => ({
      verification: {
        sha: "9f8e7d6",
        passed: true,
        checks: [],
        criteria: [],
        humanCriteria: [],
        tester: { agent: { agent: "claude-code", model: "claude-sonnet-4-5" }, verdicts: [], logPath: "../../../secret.txt" },
      },
    }));

    expect(page.body).toContain("Acceptance tester");
    expect(logHrefs(page.body)).toEqual([]);
  });

  it("should leave the tester without a link when run.json keeps no log for it", async () => {
    const page = await pageWith(() => ({
      verification: {
        sha: "9f8e7d6",
        passed: true,
        checks: [],
        criteria: [],
        humanCriteria: [],
        tester: { agent: { agent: "claude-code", model: "claude-sonnet-4-5" }, verdicts: [] },
      },
    }));

    expect(page.body).toContain("Acceptance tester");
    expect(logHrefs(page.body)).toEqual([]);
  });
});
