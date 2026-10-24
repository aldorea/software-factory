import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { approveSpec } from "../../src/commands/approve.ts";
import { runIssue, type RunRequest } from "../../src/coordinator/run.ts";
import { execOk } from "../../src/workers/sh.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeGitHub } from "../fakes/github.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeWorkerRunner, type AttemptScript, type WorkerFaults } from "../fakes/worker-runner.ts";
import { tempDirs } from "../temp-dirs.ts";

export const temp = tempDirs();

export const ISSUE = 42;
export const BRANCH = "factory/42-greeting";
export const TOKEN = "token-of-the-host";

export const ISSUE_BODY = [
  "## What to build",
  "",
  "A greeting.",
  "",
  "## Acceptance criteria",
  "",
  "- [ ] A1 The greeting says hello.",
  "",
].join("\n");

export function specText(data: object): string {
  return ["# Spec #42", "", "One subtask writes the greeting.", "", "```json factory-spec", JSON.stringify(data, null, 2), "```", ""].join("\n");
}

export const SPEC = specText({
  files: { A1: ["src/greeting.txt"] },
  base: null,
  subtasks: [{ id: "S1", criteria: ["A1"], scope: ["src/"], dependsOn: [], testChanges: [] }],
  criteria: { A1: { evidence: "request", level: "subtask" } },
});

export const WITH_HUMAN_CRITERION = {
  issueBody: ISSUE_BODY.replace("A1 The greeting says hello.", "A1 The greeting says hello.\n- [ ] A2 The greeting looks friendly."),
  spec: specText({
    files: { A1: ["src/greeting.txt"], A2: ["src/greeting.txt"] },
    base: null,
    subtasks: [{ id: "S1", criteria: ["A1", "A2"], scope: ["src/"], dependsOn: [], testChanges: [] }],
    criteria: {
      A1: { evidence: "request", level: "subtask" },
      A2: { evidence: "human", level: "integration", reason: "Looks are subjective" },
    },
  }),
};

export const CONFIG = `
export default {
  image: "greeting-worker:dev",
  checks: [{ name: "greeting", command: "grep -q hello src/greeting.txt" }],
  evidence: { request: "grep -q hello src/greeting.txt # {{id}}" },
  environment: ({ purpose, subtask, slot }) => ({
    DATABASE_URL: "postgres://neon/" + (subtask ?? purpose),
    E2E_PORT: String(4000 + slot),
  }),
  protectedPaths: ["package.json"],
  roles: {
    workers: { agent: "claude-code", model: "sonnet" },
    verifier: { agent: "opencode", model: "opencode-go/kimi-k2" },
  },
};
`;

export async function git(dir: string, ...args: string[]): Promise<string> {
  return (await execOk("git", ["-C", dir, ...args])).trim();
}

export interface Target {
  repoDir: string;
  remoteDir: string;
  github: FakeGitHub;
}

export async function targetRepo(options: { config?: string | null; issueBody?: string; spec?: string } = {}): Promise<Target> {
  const repoDir = await temp.make("run-target-");
  const remoteDir = await temp.make("run-remote-");
  await execOk("git", ["init", "-q", "--bare", "-b", "main", remoteDir]);
  await execOk("git", ["init", "-q", "-b", "main", repoDir]);
  await git(repoDir, "config", "user.name", "t");
  await git(repoDir, "config", "user.email", "t@t");
  await git(repoDir, "remote", "add", "origin", remoteDir);
  await writeFile(join(repoDir, "README.md"), "# greeting\n");
  await writeFile(join(repoDir, ".gitignore"), ".factory/logs/\n.factory/worktrees/\n");
  const config = options.config === undefined ? CONFIG : options.config;
  if (config !== null) {
    await mkdir(join(repoDir, ".factory"));
    await writeFile(join(repoDir, ".factory", "config.ts"), config);
  }
  await git(repoDir, "add", ".");
  await git(repoDir, "commit", "-q", "-m", "init");
  await git(repoDir, "push", "-q", "origin", "main");
  await git(repoDir, "switch", "-q", "-c", BRANCH);
  await mkdir(join(repoDir, "specs"));
  await writeFile(join(repoDir, "specs", "42.md"), options.spec ?? SPEC);
  await git(repoDir, "add", ".");
  await git(repoDir, "commit", "-q", "-m", "Spec #42");
  await git(repoDir, "switch", "-q", "main");
  const github = new FakeGitHub([{ number: ISSUE, title: "Greeting", body: options.issueBody ?? ISSUE_BODY }]);
  await approveSpec({ repoDir, issue: ISSUE, github, protectedPaths: ["package.json"], now: new Date("2026-10-24T07:00:00Z") });
  return { repoDir, remoteDir, github };
}

export function harness(target: Target, script: AttemptScript, faults: WorkerFaults = {}) {
  const runner = new FakeWorkerRunner(script, faults);
  const notifier = new FakeNotifier();
  const clock = new FakeClock("2026-10-24T08:00:00.000Z");
  const request: RunRequest = {
    repoDir: target.repoDir,
    issue: ISSUE,
    credentials: { "claude-code": TOKEN },
  };
  const run = () => runIssue(request, { runner, github: target.github, notifier, clock });
  return { runner, notifier, clock, run };
}

export const writesHello: AttemptScript = () => ({ files: { "src/greeting.txt": "hello\n" }, commit: "Write the greeting" });
export const writesBye: AttemptScript = () => ({ files: { "src/greeting.txt": "bye\n" }, commit: "Write the greeting" });

