import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RoleChoice } from "../../src/config/config.ts";
import { runIssue } from "../../src/coordinator/run.ts";
import { DockerWorkerRunner } from "../../src/workers/docker-runner.ts";
import type { AgentKind, Worker, WorkerRunner, WorkerSpec } from "../../src/workers/types.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeVerifier } from "../fakes/verifier.ts";
import { FakeWorkerRunner, type AttemptScript } from "../fakes/worker-runner.ts";
import { ISSUE, specText, targetRepo, temp } from "../coordinator/harness.ts";

const IMAGE = "software-factory/worker:dev";
const CLAUDE_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const OPENCODE_KEY = process.env.OPENCODE_API_KEY;

afterEach(async ({ task }) => {
  if (task.result?.state === "fail") temp.keepAll();
  else await temp.removeAll();
});

const ISSUE_BODY = ["## Acceptance criteria", "", "- [ ] A1 A GET request to / answers with the word hello.", ""].join("\n");

const SPEC = specText({
  files: { A1: ["server.js"] },
  base: null,
  subtasks: [{ id: "S1", criteria: ["A1"], scope: ["server.js"], dependsOn: [], testChanges: [] }],
  criteria: { A1: { evidence: "request", level: "subtask" } },
});

function config(tester: RoleChoice): string {
  return `
export default {
  image: ${JSON.stringify(IMAGE)},
  checks: [{ name: "syntax", command: "node --check server.js" }],
  app: { start: "node server.js", ready: "curl -sf http://localhost:$E2E_PORT/ >/dev/null", readyTimeoutMs: 20000 },
  evidence: { request: "curl -sf http://localhost:$E2E_PORT/ >/dev/null # {{id}}" },
  environment: ({ purpose }) => ({ E2E_PORT: purpose === "tester" ? "4100" : "4000" }),
  protectedPaths: ["package.json"],
  roles: {
    workers: { agent: "claude-code", model: "sonnet" },
    verifier: { agent: "opencode", model: "opencode-go/kimi-k2" },
    tester: ${JSON.stringify(tester)},
  },
};
`;
}

const server = (word: string) =>
  `require("node:http").createServer((_, res) => res.end(${JSON.stringify(`${word}\n`)})).listen(Number(process.env.E2E_PORT));\n`;

const answersBye: AttemptScript = (call) => ({
  files: { "server.js": server(call.spec.id.includes("followup") ? "hello" : "bye") },
  commit: "Serve the greeting",
});

class ChecksInDocker implements WorkerRunner {
  private readonly docker = new DockerWorkerRunner();
  private readonly fake: FakeWorkerRunner;

  constructor(script: AttemptScript) {
    this.fake = new FakeWorkerRunner(script);
  }

  start(spec: WorkerSpec): Promise<Worker> {
    return spec.branch.startsWith("factory-check/") ? this.docker.start(spec) : this.fake.start(spec);
  }
}

async function testedRun(tester: RoleChoice, credentials: Partial<Record<AgentKind, string>>) {
  const target = await targetRepo({ config: config(tester), issueBody: ISSUE_BODY, spec: SPEC });
  const report = await runIssue(
    { repoDir: target.repoDir, issue: ISSUE, credentials },
    {
      runner: new ChecksInDocker(answersBye),
      verifier: new FakeVerifier(),
      github: target.github,
      notifier: new FakeNotifier(),
      clock: new FakeClock(new Date().toISOString()),
    },
  );
  return { target, report, runDir: join(target.repoDir, ".factory", "logs", report.log.runId) };
}

async function expectByeFailedThenHelloPassed(tester: RoleChoice, credentials: Partial<Record<AgentKind, string>>) {
  const { report, runDir } = await testedRun(tester, credentials);

  expect(report.log.testerFailures?.map((failure) => failure.criterion), JSON.stringify(report.log.verification)).toEqual(["A1"]);
  expect(report.log.verification?.tester?.error, report.log.verification?.tester?.logPath).toBeUndefined();
  expect(report.log.verification?.tester?.verdicts.map((verdict) => [verdict.id, verdict.passed])).toEqual([["A1", true]]);
  for (const path of report.log.verification?.tester?.verdicts.flatMap((verdict) => verdict.evidence) ?? []) {
    expect(existsSync(join(runDir, path)), path).toBe(true);
  }
  expect(report.log.testerUsage?.[tester.agent]?.outputTokens).toBeGreaterThan(0);
  expect(report.result).toBe("ready");
}

describe.skipIf(!process.env.FACTORY_DOCKER_TESTS)("the acceptance tester against a real app in Docker", { timeout: 900_000 }, () => {
  it.skipIf(!CLAUDE_TOKEN)(
    "should fail a criterion whose command passes while the app answers bye, and pass it after the follow-up, with Claude Code",
    () => expectByeFailedThenHelloPassed({ agent: "claude-code", model: "haiku" }, { "claude-code": CLAUDE_TOKEN ?? "" }),
  );

  it.skipIf(!OPENCODE_KEY)(
    "should fail a criterion whose command passes while the app answers bye, and pass it after the follow-up, with OpenCode Go",
    () =>
      expectByeFailedThenHelloPassed(
        { agent: "opencode", model: "opencode-go/glm-5.3" },
        { "claude-code": "unused", opencode: OPENCODE_KEY ?? "" },
      ),
  );
});
