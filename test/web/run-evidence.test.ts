import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeRunLog, type RunLog, type VerificationRecord } from "../../src/coordinator/run-log.ts";
import { handleRequest } from "../../src/web/handler.ts";
import type { RunDetail } from "../../src/web/run-detail.ts";
import { attemptRecord, subtaskRecord } from "../coordinator/run-log-fixtures.ts";
import { aRun, request, runDetailIn, temp } from "./web-helpers.ts";

afterEach(() => temp.removeAll());

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10]);
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0xff]);

interface Page {
  dir: string;
  runDir: string;
  runId: string;
  body: string;
  run: RunDetail;
}

async function pageWith(build: (runDir: string) => Partial<RunLog>, files: Record<string, string | Buffer> = {}): Promise<Page> {
  const dir = await temp.make("web-run-evidence-");
  const base = aRun(0, { issue: 23 });
  const runDir = join(dir, ".factory", "logs", base.runId);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(runDir, name)), { recursive: true });
    await writeFile(join(runDir, name), content);
  }
  await writeRunLog(join(runDir, "run.json"), { ...base, ...build(runDir) });
  const response = await handleRequest(request(dir, `/api/runs/${base.runId}`));
  return { dir, runDir, runId: base.runId, body: String(response.body), run: await runDetailIn(dir, base.runId) };
}

function verification(overrides: Partial<VerificationRecord> = {}): VerificationRecord {
  return { sha: "9f8e7d6", passed: false, checks: [], criteria: [], humanCriteria: [], ...overrides };
}

describe("the causes and the steps on the page of a run", () => {
  it("should give the causes and the steps of the run, decided by the server", async () => {
    const page = await pageWith(() => ({ result: "draft", subtasks: [subtaskRecord("health", { state: "blocked", blockType: "patience", reason: "5 attempts" })] }));

    expect(page.run.causes.map((cause) => [cause.where, cause.what, cause.next?.text])).toEqual([
      ["Subtask health", "blocked (patience)", "Revisa la spec y empieza un run nuevo"],
    ]);
    expect(page.run.steps.map((step) => [step.kind, step.state])).toEqual([
      ["subtask", "failed"],
      ["integrated-verification", "not-run"],
      ["publication", "not-run"],
    ]);
  });
});

describe("the raw logs on the page of a run", () => {
  it("should link no .jsonl, neither of an attempt, of an independent verifier verdict nor of the acceptance tester", async () => {
    const page = await pageWith(
      (runDir) => ({
        subtasks: [
          subtaskRecord("S1", {
            attempts: [{ ...attemptRecord("claude-code", 1, 1), logPath: join(runDir, "S1-attempt-1.jsonl") }],
            gate: { sha: "abc", accepted: true, reasons: [], checks: [], criteria: [], verifier: [{ id: "A1", verdict: "accept", logPath: join(runDir, "S1-verifier-A1.jsonl") }] },
          }),
        ],
        verification: verification({ tester: { agent: { agent: "claude-code", model: "m" }, verdicts: [], logPath: "verification-tester.jsonl" } }),
      }),
      { "S1-attempt-1.jsonl": "{}\n", "S1-verifier-A1.jsonl": "{}\n", "verification-tester.jsonl": "{}\n" },
    );

    expect(page.body).not.toContain(".jsonl");
  });

  it("should not link an output log that run.json names with the extension of a raw log, so no path of run.json can link one", async () => {
    const check = { name: "test", command: "pnpm test", exitCode: 1, passed: false, outputLog: "S1-attempt-1.jsonl" };
    const page = await pageWith(() => ({ verification: verification({ checks: [check] }) }), { "S1-attempt-1.jsonl": "{}\n" });

    expect(page.run.verification?.checks[0]?.outputUrl).toBeNull();
  });
});

describe("the verification of a run with its evidence", () => {
  it("should give each check with its command, exit code and its output formatted in the page when it fails", async () => {
    const checks = [
      { name: "lint", command: "pnpm lint", exitCode: 0, passed: true, outputTail: "all good" },
      { name: "test", command: "pnpm test", exitCode: 1, passed: false, firstError: "1 failed", outputTail: "FAIL a.test.ts\n<script>alert(1)</script>" },
    ];
    const page = await pageWith(() => ({ verification: verification({ checks }) }));

    expect(page.run.verification?.checks).toEqual([
      { name: "lint", command: "pnpm lint", exitCode: 0, passed: true, firstError: null, output: null, outputUrl: null },
      { name: "test", command: "pnpm test", exitCode: 1, passed: false, firstError: "1 failed", output: "FAIL a.test.ts\n<script>alert(1)</script>", outputUrl: null },
    ]);
  });

  it("should give the screenshots and the video of a criterion as images and videos served from the run folder", async () => {
    const criterion = {
      id: "A3",
      evidence: "playwright" as const,
      command: "playwright test A3",
      exitCode: 1,
      passed: false,
      outputTail: "expected 200",
      evidenceFiles: ["evidence/A3/home.png", "evidence/A3/video.webm", "evidence/A3/trace.zip"],
    };
    const page = await pageWith(() => ({ verification: verification({ criteria: [criterion] }) }), {
      "evidence/A3/home.png": PNG,
      "evidence/A3/video.webm": WEBM,
      "evidence/A3/trace.zip": "zip",
    });

    expect(page.run.verification?.criteria).toEqual([
      {
        id: "A3",
        command: "playwright test A3",
        exitCode: 1,
        passed: false,
        output: "expected 200",
        outputUrl: null,
        files: [
          { name: "evidence/A3/home.png", url: `/runs/${page.runId}/evidence/A3/home.png`, media: "image" },
          { name: "evidence/A3/video.webm", url: `/runs/${page.runId}/evidence/A3/video.webm`, media: "video" },
          { name: "evidence/A3/trace.zip", url: `/runs/${page.runId}/evidence/A3/trace.zip`, media: "file" },
        ],
      },
    ]);
  });

  it("should give the files of each verdict of the acceptance tester and of each human criterion", async () => {
    const tester = { agent: { agent: "claude-code" as const, model: "m" }, verdicts: [{ id: "A1", passed: false, observation: "no button", evidence: ["tester/A1/shot.jpg"] }] };
    const humanCriteria = [{ id: "H1", reason: "layout", attachments: ["attachments/H1/page.mp4"] }];
    const page = await pageWith(() => ({ verification: verification({ tester, humanCriteria }) }), { "tester/A1/shot.jpg": PNG, "attachments/H1/page.mp4": WEBM });

    expect(page.run.verification?.tester?.verdicts).toEqual([
      { id: "A1", passed: false, observation: "no button", evidence: ["tester/A1/shot.jpg"], files: [{ name: "tester/A1/shot.jpg", url: `/runs/${page.runId}/tester/A1/shot.jpg`, media: "image" }] },
    ]);
    expect(page.run.verification?.humanCriteria).toEqual([
      { id: "H1", reason: "layout", attachments: ["attachments/H1/page.mp4"], files: [{ name: "attachments/H1/page.mp4", url: `/runs/${page.runId}/attachments/H1/page.mp4`, media: "video" }] },
    ]);
  });

  it("should not give an evidence file that is missing or that a symlink takes outside the run folder", async () => {
    const outside = await temp.make("web-run-evidence-outside-");
    await writeFile(join(outside, "secret.png"), PNG);
    const criterion = { id: "A3", evidence: "playwright" as const, command: "c", exitCode: 0, passed: true, evidenceFiles: ["evidence/A3/missing.png", "evidence/A3/link.png", "../../../etc/passwd.png"] };
    const page = await pageWith(() => ({ verification: verification({ criteria: [criterion] }) }));
    await mkdir(join(page.runDir, "evidence", "A3"), { recursive: true });
    await symlink(join(outside, "secret.png"), join(page.runDir, "evidence", "A3", "link.png"));

    expect((await runDetailIn(page.dir, page.runId)).verification?.criteria[0]?.files).toEqual([]);
  });
});

describe("the files of a run by their type", () => {
  it("should serve a PNG as image/png and a JPEG as image/jpeg, byte for byte", async () => {
    const page = await pageWith(() => ({}), { "evidence/A3/home.png": PNG, "evidence/A3/home.jpeg": PNG, "evidence/A3/home.jpg": PNG });

    for (const [name, type] of [
      ["home.png", "image/png"],
      ["home.jpeg", "image/jpeg"],
      ["home.jpg", "image/jpeg"],
    ] as const) {
      const response = await handleRequest(request(page.dir, `/runs/${page.runId}/evidence/A3/${name}`));
      expect(response.status).toBe(200);
      expect(response.contentType).toBe(type);
      expect(Buffer.from(response.body)).toEqual(await readFile(join(page.runDir, "evidence", "A3", name)));
    }
  });

  it("should serve a WebM as video/webm and an MP4 as video/mp4", async () => {
    const page = await pageWith(() => ({}), { "evidence/A3/video.webm": WEBM, "evidence/A3/video.mp4": WEBM });

    const webm = await handleRequest(request(page.dir, `/runs/${page.runId}/evidence/A3/video.webm`));
    const mp4 = await handleRequest(request(page.dir, `/runs/${page.runId}/evidence/A3/video.mp4`));

    expect([webm.status, webm.contentType]).toEqual([200, "video/webm"]);
    expect(Buffer.from(webm.body)).toEqual(WEBM);
    expect([mp4.status, mp4.contentType]).toEqual([200, "video/mp4"]);
  });

  it("should still serve any other file of the run as plain text, so a log that holds HTML is never run", async () => {
    const page = await pageWith(() => ({}), { "output/check.log": "<script>alert(1)</script>" });

    const response = await handleRequest(request(page.dir, `/runs/${page.runId}/output/check.log`));

    expect([response.status, response.contentType, response.body]).toEqual([200, "text/plain; charset=utf-8", "<script>alert(1)</script>"]);
  });

  it("should answer 404 to a PNG symlink that points outside the run folder", async () => {
    const outside = await temp.make("web-run-evidence-outside-");
    await writeFile(join(outside, "secret.png"), PNG);
    const page = await pageWith(() => ({}));
    await symlink(join(outside, "secret.png"), join(page.runDir, "leak.png"));

    expect((await handleRequest(request(page.dir, `/runs/${page.runId}/leak.png`))).status).toBe(404);
  });
});
