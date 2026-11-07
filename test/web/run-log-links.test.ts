import { appendFile, mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeRunLog, type RunLog } from "../../src/coordinator/run-log.ts";
import { handleRequest } from "../../src/web/handler.ts";
import { attemptRecord, subtaskRecord } from "../coordinator/run-log-fixtures.ts";
import type { RunDetail } from "../../src/web/run-detail.ts";
import { aRun, request, runDetailIn, temp } from "./web-helpers.ts";

afterEach(() => temp.removeAll());

interface Page {
  dir: string;
  runDir: string;
  runId: string;
  run: RunDetail;
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
  return { dir, runDir, runId: base.runId, run: await runDetailIn(dir, base.runId) };
}

type Linked = { outputUrl?: string | null };

function logHrefs(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(logHrefs);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, field]) =>
    (key === "url" || key === "outputUrl") && typeof field === "string" ? [field] : logHrefs(field),
  );
}

function itemsOf(run: RunDetail, kind: "attempt" | "check" | "criterion" | "verifier"): unknown[] {
  const gates = run.subtasks.flatMap((subtask) => (subtask.gate === null ? [] : [subtask.gate]));
  if (kind === "attempt") return run.subtasks.flatMap((subtask) => subtask.attempts);
  if (kind === "verifier") return gates.flatMap((gate) => gate.verifier);
  if (kind === "criterion") return [...gates.flatMap((gate) => gate.criteria), ...(run.verification?.criteria ?? [])];
  return [...gates.flatMap((gate) => gate.checks), ...(run.verification?.checks ?? []), ...(run.block?.checks ?? []), ...(run.verification?.tester?.checks ?? [])];
}

function hrefIn(item: unknown): string | undefined {
  return (item as Linked | undefined)?.outputUrl ?? undefined;
}

async function open(page: Page, href: string | undefined) {
  expect(href).toBeDefined();
  return handleRequest(request(page.dir, href ?? ""));
}

function withOutput(outputLog: string) {
  return {
    verification: {
      sha: "9f8e7d6",
      passed: false,
      humanCriteria: [],
      criteria: [],
      checks: [{ name: "test", command: "pnpm test", exitCode: 1, passed: false, outputLog }],
    },
  };
}

describe("the raw log of an attempt", () => {
  it("should not be linked, because the web shows the activity of an attempt and never its raw log", async () => {
    const page = await pageWith(
      (runDir) => ({
        subtasks: [subtaskRecord("S1", { attempts: [{ ...attemptRecord("claude-code", 10, 5), logPath: join(runDir, "S1-attempt-1.jsonl") }] })],
      }),
      { "S1-attempt-1.jsonl": '{"type":"assistant"}\n' },
    );

    expect(page.run.subtasks[0]?.attempts).toHaveLength(1);
    expect(logHrefs(page.run)).toEqual([]);
  });

  it("should still be served as plain text to whoever asks for its path, under the path rules of the run folder", async () => {
    const page = await pageWith(
      (runDir) => ({ subtasks: [subtaskRecord("S1", { state: "working", attempts: [{ ...attemptRecord("claude-code", 0, 0), logPath: join(runDir, "S1-attempt-1.jsonl") }] })] }),
      { "S1-attempt-1.jsonl": '{"type":"assistant"}\n' },
    );
    await appendFile(join(page.runDir, "S1-attempt-1.jsonl"), '{"type":"result"}\n');

    const response = await open(page, `/runs/${page.runId}/S1-attempt-1.jsonl`);

    expect(response.status).toBe(200);
    expect(response.contentType).toMatch(/^text\/plain/);
    expect(response.body).toBe('{"type":"assistant"}\n{"type":"result"}\n');
  });
});

describe("an output path that is not inside the run folder", () => {
  it.each([
    ["an absolute path outside the run", () => "/logs/attempt.log"],
    ["the absolute path of a system file", () => "/etc/passwd"],
    ["a relative path that climbs out of the run", () => "../../../secret.txt"],
    ["an absolute path that climbs out of the run", (runDir: string) => `${runDir}/../../../secret.txt`],
    ["the absolute path of a file in a sibling run", (runDir: string) => `${dirname(runDir)}/46-2026-10-25T08-00-00-000Z/a.log`],
    ["a path in a folder whose name starts like the run", (runDir: string) => `${runDir}-copy/a.log`],
    ["the run folder itself", (runDir: string) => runDir],
    ["an empty path", () => ""],
    ["a path with a NUL byte", (runDir: string) => `${runDir}/a.log\0.txt`],
  ])("should not be linked when it is %s", async (_name, outputLog) => {
    const page = await pageWith((runDir) => withOutput(outputLog(runDir)), { "a.log": "inside" });

    expect(itemsOf(page.run, "check")).toHaveLength(1);
    expect(logHrefs(page.run)).toEqual([]);
  });

  it("should not be linked when it goes through a symlink that points outside the run", async () => {
    const dir = await temp.make("web-run-links-outside-");
    await writeFile(join(dir, "secret.txt"), "the-secret");
    const base = aRun(0);
    const runDir = join(dir, ".factory", "logs", base.runId);
    await mkdir(runDir, { recursive: true });
    await symlink(join(dir, "secret.txt"), join(runDir, "leak.log"));
    await symlink(dir, join(runDir, "linked"));
    const checks = ["leak.log", "linked/secret.txt"].map((name) => ({ name, command: "c", exitCode: 1, passed: false, outputLog: join(runDir, name) }));
    await writeRunLog(join(runDir, "run.json"), { ...base, verification: { sha: "s", passed: false, humanCriteria: [], criteria: [], checks } });

    const run = await runDetailIn(dir, base.runId);

    expect(itemsOf(run, "check")).toHaveLength(2);
    expect(logHrefs(run)).toEqual([]);
  });

  it("should not be linked, and should not break the page, when run.json holds something that is not a string", async () => {
    const page = await pageWith(() => withOutput(42 as unknown as string));

    expect(itemsOf(page.run, "check")).toHaveLength(1);
    expect(logHrefs(page.run)).toEqual([]);
  });

  it("should not be linked when the file does not exist, so the page has no dead link", async () => {
    const page = await pageWith((runDir) => withOutput(join(runDir, "missing.log")));

    expect(logHrefs(page.run)).toEqual([]);
  });

  it("should encode an output name that has characters of a URL", async () => {
    const page = await pageWith(() => withOutput("a b#c?.log"), { "a b#c?.log": "odd name" });

    const href = hrefIn(itemsOf(page.run, "check")[0]);
    expect(href).toBe(`/runs/${page.runId}/a%20b%23c%3F.log`);
    expect((await open(page, href)).body).toBe("odd name");
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

    const [passed, failed] = itemsOf(page.run, "check");
    expect(hrefIn(passed)).toBeUndefined();
    const href = hrefIn(failed);
    expect(href).toBe(`/runs/${page.runId}/output/gate/check-2-test.log`);
    const response = await open(page, href);
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

    const href = hrefIn(itemsOf(page.run, "criterion")[0]);
    expect(href).toBe(`/runs/${page.runId}/output/gate/C1.log`);
    expect((await open(page, href)).body).toBe("curl: (22) 404\n");
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

    expect((await open(page, hrefIn(itemsOf(page.run, "check")[0]))).body).toBe("check output");
    expect((await open(page, hrefIn(itemsOf(page.run, "criterion")[0]))).body).toBe("criterion output");
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

    expect(logHrefs(page.run)).toEqual([`/runs/${page.runId}/output/final/check-1-test.log`]);
    expect((await open(page, logHrefs(page.run)[0])).body).toBe("block output");
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

    expect(itemsOf(page.run, "check")).toHaveLength(1);
    expect(logHrefs(page.run)).toEqual([]);
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

    expect(itemsOf(page.run, "check")).toHaveLength(1);
    expect(itemsOf(page.run, "criterion")).toHaveLength(1);
    expect(logHrefs(page.run)).toEqual([]);
  });
});

describe("the raw logs of the independent verifier and the acceptance tester", () => {
  it("should not be linked, though they are inside the run folder", async () => {
    const page = await pageWith(
      (runDir) => ({
        subtasks: [
          subtaskRecord("S1", {
            gate: { sha: "abc1234", accepted: false, reasons: [], checks: [], criteria: [], verifier: [{ id: "C1", verdict: "accept", logPath: join(runDir, "gate-verifier-C1.jsonl") }] },
          }),
        ],
        verification: {
          sha: "9f8e7d6",
          passed: true,
          checks: [],
          criteria: [],
          humanCriteria: [],
          tester: { agent: { agent: "claude-code", model: "claude-sonnet-4-5" }, verdicts: [], logPath: "final-tester.jsonl" },
        },
      }),
      { "gate-verifier-C1.jsonl": "accept log", "final-tester.jsonl": "tester log" },
    );

    expect(itemsOf(page.run, "verifier")).toHaveLength(1);
    expect(page.run.verification?.tester).not.toBeNull();
    expect(logHrefs(page.run)).toEqual([]);
  });

  it("should open the output of the check that failed while the tester prepared the app", async () => {
    const page = await pageWith(
      () => ({
        verification: {
          sha: "9f8e7d6",
          passed: false,
          checks: [],
          criteria: [],
          humanCriteria: [],
          tester: {
            agent: { agent: "claude-code", model: "claude-sonnet-4-5" },
            verdicts: [],
            error: "The app did not start for the acceptance tester: the install check failed: ERR_PNPM_FETCH_404",
            checks: [
              {
                name: "install",
                command: "pnpm install --frozen-lockfile",
                exitCode: 1,
                passed: false,
                outputTail: "ERR_PNPM_FETCH_404",
                outputLog: "output/verification-tester/check-1-install.log",
              },
            ],
          },
        },
      }),
      { "output/verification-tester/check-1-install.log": "ERR_PNPM_FETCH_404 the registry is unreachable" },
    );

    expect(logHrefs(page.run)).toEqual([`/runs/${page.runId}/output/verification-tester/check-1-install.log`]);
    expect((await open(page, logHrefs(page.run)[0])).body).toBe("ERR_PNPM_FETCH_404 the registry is unreachable");
  });
});
