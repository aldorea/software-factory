import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InteractiveLaunch } from "../../src/cli/launch.ts";
import { main, type CliEnv } from "../../src/cli/main.ts";
import type { RoleEntry } from "../../src/cli/role-menu.ts";
import type { Role, RoleChoice } from "../../src/config/config.ts";
import { parseRunLog } from "../../src/coordinator/run-log.ts";
import { countedTokens } from "../../src/coordinator/stop-rules.ts";
import type { GitHub } from "../../src/github/github.ts";
import { ghGitHub, ghProblem } from "../../src/github/gh.ts";
import { readApproval } from "../../src/spec/approval.ts";
import { dockerProblem } from "../../src/workers/docker.ts";
import type { ActivityEvent } from "../../src/workers/types.ts";
import { execOk } from "../../src/workers/sh.ts";
import { writeRunningRun } from "../coordinator/running-run.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeGitHub } from "../fakes/github.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeVerifier } from "../fakes/verifier.ts";
import { FakeWorkerRunner, type AttemptScript } from "../fakes/worker-runner.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

const BRANCH = "factory/42-saved-searches";
const issueBody = "## Acceptance criteria\n\n- [ ] A1 one\n- [ ] A2 two\n- [ ] A3 three\n";

const CONFIG = `export default {
  image: "worker:dev",
  checks: [{ name: "spec", command: "test -f specs/42.md" }],
  evidence: { request: "test -f specs/42.md # {{id}}" },
  environment: () => ({}),
  protectedPaths: ["package.json"],
  roles: {
    workers: { agent: "claude-code", model: "sonnet" },
    verifier: { agent: "opencode", model: "opencode-go/kimi-k2" },
    tester: { agent: "claude-code", model: "sonnet" },
  },
};
`;

const ONE_SUBTASK_SPEC = [
  "# Spec #42",
  "",
  "```json factory-spec",
  JSON.stringify({
    files: { A1: ["src/a.txt"], A2: ["src/a.txt"], A3: ["src/a.txt"] },
    base: null,
    subtasks: [{ id: "S1", criteria: ["A1", "A2", "A3"], scope: ["src/"], dependsOn: [], testChanges: [] }],
    criteria: {
      A1: { evidence: "request", level: "subtask" },
      A2: { evidence: "request", level: "subtask" },
      A3: { evidence: "request", level: "subtask" },
    },
  }),
  "```",
  "",
].join("\n");

async function git(dir: string, ...args: string[]): Promise<string> {
  return (await execOk("git", ["-C", dir, ...args])).trim();
}

async function targetRepo(spec: string, config: string | null = CONFIG): Promise<string> {
  const dir = await temp.make("cli-test-");
  await execOk("git", ["init", "-q", "-b", BRANCH, dir]);
  await git(dir, "config", "user.name", "t");
  await git(dir, "config", "user.email", "t@t");
  await writeFile(join(dir, ".gitignore"), ".factory/logs/\n.factory/worktrees/\n");
  if (config !== null) {
    await mkdir(join(dir, ".factory"));
    await writeFile(join(dir, ".factory", "config.ts"), config);
  }
  await mkdir(join(dir, "specs"));
  await writeFile(join(dir, "specs", "42.md"), spec);
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "Spec #42");
  await git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  return dir;
}

async function mainRepo(): Promise<string> {
  const dir = await temp.make("cli-refine-");
  await execOk("git", ["init", "-q", "-b", "main", dir]);
  await git(dir, "config", "user.name", "t");
  await git(dir, "config", "user.email", "t@t");
  await writeFile(join(dir, "README.md"), "# target\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
  const remoteDir = await temp.make("cli-refine-remote-");
  await execOk("git", ["init", "-q", "--bare", remoteDir]);
  await git(dir, "remote", "add", "origin", remoteDir);
  await git(dir, "push", "-q", "origin", "main");
  await git(dir, "remote", "set-head", "origin", "--auto");
  return dir;
}

function cli(
  cwd: string,
  github: GitHub = new FakeGitHub([{ number: 42, title: "x", body: issueBody }]),
  script?: AttemptScript,
) {
  const out: string[] = [];
  const err: string[] = [];
  const runner = new FakeWorkerRunner(script);
  const notifier = new FakeNotifier();
  const launches: InteractiveLaunch[] = [];
  const env: CliEnv = {
    cwd,
    factoryRoot: "/factory",
    clock: new FakeClock("2026-10-24T08:00:00.000Z"),
    github: () => github,
    runner: () => runner,
    verifier: () => new FakeVerifier(),
    notifier,
    credentials: { "claude-code": "token", opencode: "key" },
    docker: async () => null,
    gh: async () => null,
    launch: async (launch) => {
      launches.push(launch);
      return 0;
    },
    signal: new AbortController().signal,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };
  return { env, out, err, runner, notifier, launches };
}

const valid = () => readFile(join(import.meta.dirname, "..", "spec", "fixtures", "valid.md"), "utf8");

async function runnableRepo(config: string = CONFIG): Promise<string> {
  const repoDir = await targetRepo(ONE_SUBTASK_SPEC, config);
  const remoteDir = await temp.make("cli-remote-");
  await execOk("git", ["init", "-q", "--bare", remoteDir]);
  await git(repoDir, "remote", "add", "origin", remoteDir);
  await git(repoDir, "branch", "main");
  await git(repoDir, "push", "-q", "origin", "main");
  await git(repoDir, "remote", "set-head", "origin", "--auto");
  return repoDir;
}

async function lastRunLog(repoDir: string) {
  const logs = join(repoDir, ".factory", "logs");
  const runId = (await readdir(logs)).sort().at(-1) ?? "";
  const parsed = parseRunLog(await readFile(join(logs, runId, "run.json"), "utf8"));
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.log;
}

const OPUS: RoleChoice = { agent: "claude-code", model: "opus" };
const SONNET: RoleChoice = { agent: "claude-code", model: "sonnet" };
const KIMI: RoleChoice = { agent: "opencode", model: "opencode-go/kimi-k2" };
const GLM: RoleChoice = { agent: "opencode", model: "opencode-go/glm-4.6" };
const NO_ROLES = CONFIG.replace(/  roles: \{[\s\S]*?\n  \},\n/, "");
const CLAUDE_REFINEMENT = ["--refinement-agent", "claude-code:sonnet"];
const WITH_REFINEMENT = CONFIG.replace(
  "  roles: {\n",
  '  roles: {\n    refinement: { agent: "claude-code", model: "opus" },\n',
);
const modelOf = (launch: InteractiveLaunch | undefined) => launch?.args[(launch?.args.indexOf("--model") ?? -2) + 1];
const NO_TESTER = CONFIG.replace(/    tester: .*\n/, "");

describe("factory run: the choice of the agent of each role", () => {
  it("should take the agent and the model of each role from the flags over the config default", async () => {
    const repoDir = await runnableRepo();
    const { env } = cli(repoDir);
    expect(await main(["approve", "42"], env)).toBe(0);

    const code = await main(
      ["run", "42", "--worker-agent", "claude-code:opus", "--verifier-agent=opencode:opencode-go/glm-4.6", "--tester-agent", "opencode:opencode-go/kimi-k2"],
      env,
    );

    expect(code).toBe(0);
    expect((await lastRunLog(repoDir)).agents).toEqual({ workers: OPUS, verifier: GLM, tester: KIMI, changes: [] });
  });

  it("should ask once in a terminal with every role, its default and where each value comes from, a flag marking its role as fixed", async () => {
    const repoDir = await runnableRepo();
    const { env } = cli(repoDir);
    expect(await main(["approve", "42"], env)).toBe(0);
    const asked: RoleEntry[][] = [];
    env.ask = async (entries) => {
      asked.push(entries);
      return { verifier: GLM, tester: GLM };
    };

    expect(await main(["run", "42", "--worker-agent", "claude-code:opus"], env)).toBe(0);

    expect(asked).toEqual([
      [
        { role: "workers", offered: ["claude-code", "opencode"], choice: OPUS, origin: "flag" },
        { role: "verifier", offered: ["claude-code", "opencode"], choice: KIMI, origin: "config" },
        { role: "tester", offered: ["claude-code", "opencode"], choice: SONNET, origin: "config" },
      ],
    ]);
    expect((await lastRunLog(repoDir)).agents).toEqual({ workers: OPUS, verifier: GLM, tester: GLM, changes: [] });
  });

  it("should reject before it asks and before any worker starts a flag that is not an agent and a model", async () => {
    const repoDir = await runnableRepo();
    const { env, err, runner } = cli(repoDir);
    expect(await main(["approve", "42"], env)).toBe(0);
    let asked = false;
    env.ask = async () => {
      asked = true;
      return {};
    };

    expect(await main(["run", "42", "--tester-agent", "gemini:pro"], env)).toBe(1);

    expect(err.join("\n")).toContain("gemini is not an agent");
    expect(asked).toBe(false);
    expect(runner.workers).toEqual([]);
  });

  it("should refuse before any worker starts an OpenCode model outside opencode-go/ that the terminal gave", async () => {
    const repoDir = await runnableRepo();
    const { env, err, runner } = cli(repoDir);
    expect(await main(["approve", "42"], env)).toBe(0);
    env.ask = async () => ({ verifier: { agent: "opencode", model: "opencode/kimi-k2" } });

    expect(await main(["run", "42"], env)).toBe(1);

    expect(err.join("\n")).toContain("the verifier model must be an opencode-go/ model");
    expect(runner.workers).toEqual([]);
  });

  it("should take the config default with no flag outside a terminal", async () => {
    const repoDir = await runnableRepo();
    const { env } = cli(repoDir);
    expect(await main(["approve", "42"], env)).toBe(0);

    expect(await main(["run", "42"], env)).toBe(0);

    expect((await lastRunLog(repoDir)).agents).toEqual({ workers: SONNET, verifier: KIMI, tester: SONNET, changes: [] });
  });

  it("should point to factory web and print the progress of the run before its result line", async () => {
    const repoDir = await runnableRepo();
    const { env, out } = cli(repoDir);
    expect(await main(["approve", "42"], env)).toBe(0);
    out.length = 0;

    expect(await main(["run", "42"], env)).toBe(0);

    expect(out[0]).toBe("Preparing run #42; factory web shows it at http://127.0.0.1:7433/");
    expect(out.some((line) => /^\d\d:\d\d:\d\d S1: working$/.test(line))).toBe(true);
    expect(out).not.toContain("S1: working");
    expect(out.some((line) => /^Run 42-.*: (ready|draft)$/.test(line))).toBe(true);
  });

  it("should print a line for each activity event of an attempt, in order, with the time and the prefix of the subtask, between the progress lines", async () => {
    const repoDir = await runnableRepo();
    const events: ActivityEvent[] = [
      { kind: "message", text: "Reading the module." },
      { kind: "tool", tool: "Read", target: "src/api/users.ts" },
      { kind: "tool", tool: "Edit", target: "src/api/users.ts" },
      { kind: "tool", tool: "Bash", target: "pnpm test" },
      { kind: "end", outcome: "completed" },
    ];
    const { env, out } = cli(repoDir, undefined, () => ({ files: { "src/a.txt": "a\n" }, activity: events }));
    env.clock = new FakeClock("2026-10-24T10:02:20");
    expect(await main(["approve", "42"], env)).toBe(0);
    out.length = 0;

    expect(await main(["run", "42"], env)).toBe(0);

    const activity = out.filter((line) => line.startsWith("10:02:20 S1 · "));
    expect(activity).toEqual([
      '10:02:20 S1 · "Reading the module."',
      "10:02:20 S1 · Read src/api/users.ts",
      "10:02:20 S1 · Edit src/api/users.ts",
      "10:02:20 S1 · Bash pnpm test",
      "10:02:20 S1 · attempt ended",
    ]);
    expect(out.indexOf("10:02:20 S1: working")).toBeLessThan(out.indexOf(activity[0] as string));
    expect(out.indexOf(activity[4] as string)).toBeLessThan(out.indexOf("10:02:20 S1: attempt 1 completed"));
  });

  it("should print no ANSI code and no bottom line when the output is not a terminal", async () => {
    const repoDir = await runnableRepo();
    const { env, out } = cli(repoDir, undefined, () => ({
      files: { "src/a.txt": "a\n" },
      activity: [{ kind: "tool", tool: "Edit", target: "src/a.txt" }],
    }));
    expect(await main(["approve", "42"], env)).toBe(0);
    out.length = 0;

    expect(await main(["run", "42"], env)).toBe(0);

    expect(out.join("\n")).not.toMatch(/\u001b|⏳/);
  });

  it("should keep every progress and activity line in the history of a terminal, colour them, and leave no bottom line when the run ends", async () => {
    const repoDir = await runnableRepo();
    const { env, out } = cli(repoDir, undefined, () => ({
      files: { "src/a.txt": "a\n" },
      activity: [
        { kind: "message", text: "Reading the module." },
        { kind: "tool", tool: "Edit", target: "src/a.txt" },
        { kind: "end", outcome: "completed" },
      ],
    }));
    env.clock = new FakeClock("2026-10-24T10:02:20");
    const writes: string[] = [];
    env.terminal = { columns: () => 120, write: (text) => writes.push(text) };
    expect(await main(["approve", "42"], env)).toBe(0);
    out.length = 0;

    expect(await main(["run", "42"], env)).toBe(0);

    const screen = writes.join("");
    const history = screen
      .replace(/⏳[^\r\n]*/g, "")
      .replace(/\r\u001b\[2K/g, "")
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split("\n")
      .filter((line) => line !== "");
    expect(history).toEqual([
      expect.stringMatching(/^10:02:20 run 42-.*: 1 subtask, workers on claude-code sonnet$/),
      "10:02:20 S1: working",
      '10:02:20 S1 · "Reading the module."',
      "10:02:20 S1 · Edit src/a.txt",
      "10:02:20 S1 · attempt ended",
      "10:02:20 S1: attempt 1 completed",
      "10:02:20 S1: gating",
      "10:02:20 S1: merged",
      expect.stringMatching(/^10:02:20 integrated verification at /),
      expect.stringMatching(/^10:02:20 run 42-.*: (ready|draft)$/),
      expect.stringMatching(/^10:02:20 pull request: /),
    ]);
    expect(screen).toContain("\u001b[2m10:02:20 \u001b[0m\u001b[32mS1: merged\u001b[0m");
    expect(screen).toContain("⏳ S1 attempt 1 · 0s · last activity 0s ago");
    expect(writes.at(-1)).not.toContain("⏳");
    expect(writes.at(-1)?.endsWith("\n")).toBe(true);
    expect(out.join("\n")).not.toMatch(/⏳|\u001b/);
    expect(out.some((line) => line.includes("S1: merged"))).toBe(false);
    expect(out.some((line) => /^Run 42-/.test(line))).toBe(true);
  });

  it("should write the same run.json for an attempt that emits activity and one that does not, because the activity is only shown", async () => {
    const written = async (activity: ActivityEvent[] | undefined) => {
      const repoDir = await runnableRepo();
      const { env } = cli(repoDir, undefined, () => ({ files: { "src/a.txt": "a\n" }, ...(activity ? { activity } : {}) }));
      env.clock = new FakeClock("2026-10-24T10:02:20");
      expect(await main(["approve", "42"], env)).toBe(0);
      expect(await main(["run", "42"], env)).toBe(0);
      const logs = join(repoDir, ".factory", "logs");
      const runId = (await readdir(logs)).sort().at(-1) ?? "";
      const text = (await readFile(join(logs, runId, "run.json"), "utf8")).replaceAll(repoDir, "<repo>").replace(/\b[0-9a-f]{40}\b/g, "<sha>");
      const parsed = JSON.parse(text) as { subtasks: { attempts: Record<string, unknown>[] }[] };
      for (const attempt of parsed.subtasks.flatMap((subtask) => subtask.attempts)) {
        delete attempt.startedAt;
        delete attempt.endedAt;
      }
      return parsed;
    };

    const quiet = await written(undefined);
    const talkative = await written([
      { kind: "message", text: "Working." },
      { kind: "tool", tool: "Edit", target: "src/a.txt" },
      { kind: "end", outcome: "completed" },
    ]);

    expect(talkative).toEqual(quiet);
  });

  it("should refuse to start, with no worker, when neither a flag, a prompt nor the config gives the agent of a role", async () => {
    const repoDir = await runnableRepo(NO_ROLES);
    const { env, err, runner } = cli(repoDir);
    expect(await main(["approve", "42"], env)).toBe(0);

    expect(await main(["run", "42", "--worker-agent", "claude-code:sonnet"], env)).toBe(1);

    expect(err.join("\n")).toContain("no agent for the verifier: pass --verifier-agent <agent>:<model> or set roles.verifier");
    expect(runner.workers).toEqual([]);
  });

  it("should refuse to start, with no worker, when no source gives the agent of the acceptance tester", async () => {
    const repoDir = await runnableRepo(NO_TESTER);
    const { env, err, runner } = cli(repoDir);
    expect(await main(["approve", "42"], env)).toBe(0);

    expect(await main(["run", "42"], env)).toBe(1);

    expect(err.join("\n")).toContain("no agent for the tester: pass --tester-agent <agent>:<model> or set roles.tester");
    expect(runner.workers).toEqual([]);
  });

  it("should refuse before the run starts a pay-per-use model asked by flag", async () => {
    const repoDir = await runnableRepo();
    const { env, err, runner } = cli(repoDir);
    expect(await main(["approve", "42"], env)).toBe(0);

    expect(await main(["run", "42", "--worker-agent", "opencode:opencode/kimi-k2"], env)).toBe(1);

    expect(err.join("\n")).toContain("the workers model must be an opencode-go/ model");
    expect(runner.workers).toEqual([]);
  });

  it("should ask again on resume with the previous choice as the default and the paused run as its origin, and record the change", async () => {
    const repoDir = await runnableRepo();
    const paused = cli(repoDir, undefined, () => ({ outcome: { kind: "plan-limit", message: "limit" } }));
    expect(await main(["approve", "42"], paused.env)).toBe(0);
    expect(await main(["run", "42", "--worker-agent", "claude-code:opus"], paused.env)).toBe(0);
    expect((await lastRunLog(repoDir)).result).toBe("paused");

    const resumed = cli(repoDir, undefined, () => ({ files: { "src/a.txt": "a\n" } }));
    const asked: RoleEntry[] = [];
    resumed.env.ask = async (entries) => {
      asked.push(...entries);
      return { workers: SONNET };
    };
    expect(await main(["run", "42"], resumed.env)).toBe(0);

    expect(asked.map((entry) => [entry.role, entry.choice, entry.origin])).toEqual([
      ["workers", OPUS, "paused run"],
      ["verifier", KIMI, "paused run"],
      ["tester", SONNET, "paused run"],
    ]);
    expect((await lastRunLog(repoDir)).agents.changes).toEqual([
      { role: "workers", from: OPUS, to: SONNET, at: "2026-10-24T08:00:00.000Z" },
    ]);
  });

  it("should warn on resume that the run will pause again when the agent that reached the plan limit is still chosen and its reset is in the future", async () => {
    const repoDir = await runnableRepo();
    const resetsAt = new Date("2026-10-24T14:00:00.000Z");
    const paused = cli(repoDir, undefined, () => ({ outcome: { kind: "plan-limit", message: "limit", resetsAt } }));
    expect(await main(["approve", "42"], paused.env)).toBe(0);
    expect(await main(["run", "42", "--worker-agent", "claude-code:opus"], paused.env)).toBe(0);

    const resumed = cli(repoDir, undefined, () => ({ files: { "src/a.txt": "a\n" } }));
    const notes: Partial<Record<Role, string[]>>[] = [];
    resumed.env.ask = async (entries, annotate) => {
      notes.push(annotate(entries));
      return {};
    };
    expect(await main(["run", "42"], resumed.env)).toBe(0);

    expect(notes).toEqual([
      {
        workers: [expect.stringMatching(/^⚠ claude-code plan limit until \d\d:\d\d: the run will pause again$/)],
      },
    ]);
  });

  it("should not warn on a new run", async () => {
    const repoDir = await runnableRepo();
    const fresh = cli(repoDir, undefined, () => ({ files: { "src/a.txt": "a\n" } }));
    const notes: Partial<Record<Role, string[]>>[] = [];
    fresh.env.ask = async (entries, annotate) => {
      notes.push(annotate(entries));
      return {};
    };
    expect(await main(["approve", "42"], fresh.env)).toBe(0);
    expect(await main(["run", "42"], fresh.env)).toBe(0);

    expect(notes).toEqual([{}]);
  });

  it("should print the usage on a flag that factory run does not know, or a role flag on another command", async () => {
    const { env, err } = cli(await temp.make("cli-usage-"));

    expect(await main(["run", "42", "--worker", "claude-code"], env)).toBe(2);
    expect(await main(["approve", "42", "--worker-agent", "claude-code:opus"], env)).toBe(2);
    expect(err.join("\n")).toContain("usage: factory");
  });
});

function summaryOf(out: string[]): string[] {
  return out.slice(out.findLastIndex((line) => line.startsWith("Run ")));
}

describe("factory run: the summary at the end", () => {
  it("should print the result, the merged subtasks, the wall clock, the tokens and the pull request of a ready run", async () => {
    const repoDir = await runnableRepo();
    const { env, out } = cli(repoDir, undefined, () => ({
      files: { "src/a.txt": "a\n" },
      usage: { inputTokens: 100, outputTokens: 50 },
    }));
    expect(await main(["approve", "42"], env)).toBe(0);

    expect(await main(["run", "42"], env)).toBe(0);

    const log = await lastRunLog(repoDir);
    expect(log.result).toBe("ready");
    expect(countedTokens(log.cost.usage)).toBeGreaterThan(0);
    expect(summaryOf(out)).toEqual([
      `Run ${log.runId}: ready`,
      "Merged: S1",
      "Blocked: none",
      "Wall clock: 0 s",
      `Tokens: ${countedTokens(log.cost.usage)}`,
      "Pull request: https://github.test/pull/100",
    ]);
  });

  it("should list each blocked subtask with its type of block in a draft run", async () => {
    const repoDir = await runnableRepo();
    const { env, out } = cli(repoDir, undefined, () => ({
      outcome: { kind: "completed", summary: "FACTORY-DESIGN-QUESTION: Which greeting?" },
    }));
    expect(await main(["approve", "42"], env)).toBe(0);

    expect(await main(["run", "42"], env)).toBe(0);

    const log = await lastRunLog(repoDir);
    expect(log.result).toBe("draft");
    const summary = summaryOf(out);
    expect(summary[0]).toBe(`Run ${log.runId}: draft`);
    expect(summary).toContain("Merged: none");
    expect(summary).toContain("Blocked: S1 (design-question)");
    expect(summary.at(-1)).toBe("Pull request: https://github.test/pull/100");
  });

  it("should say when the plan limit resets in a paused run and list the subtasks that did not finish", async () => {
    const repoDir = await runnableRepo();
    const resetsAt = new Date("2026-10-24T13:00:00.000Z");
    const { env, out } = cli(repoDir, undefined, () => ({ outcome: { kind: "plan-limit", message: "limit", resetsAt } }));
    expect(await main(["approve", "42"], env)).toBe(0);

    expect(await main(["run", "42"], env)).toBe(0);

    const log = await lastRunLog(repoDir);
    expect(log.result).toBe("paused");
    const summary = summaryOf(out);
    expect(summary[0]).toBe(`Run ${log.runId}: paused until the plan limit resets at 2026-10-24T13:00:00.000Z`);
    expect(summary).toContain("Merged: none");
    expect(summary).toContain("Unfinished: S1");
  });

  it("should not count the time in pause in the wall clock, as factory stats does not", async () => {
    const repoDir = await runnableRepo();
    const paused = cli(repoDir, undefined, () => ({ outcome: { kind: "plan-limit", message: "limit" } }));
    expect(await main(["approve", "42"], paused.env)).toBe(0);
    expect(await main(["run", "42"], paused.env)).toBe(0);
    const clock = new FakeClock("2026-10-24T11:00:00.000Z");
    const resumed = cli(repoDir, undefined, () => {
      clock.advance(10 * 60_000);
      return { files: { "src/a.txt": "a\n" } };
    });
    resumed.env.clock = clock;

    expect(await main(["run", "42"], resumed.env)).toBe(0);

    const log = await lastRunLog(repoDir);
    expect(log.cost.pausedMs).toBe(3 * 3_600_000);
    expect(summaryOf(resumed.out)).toContain("Wall clock: 10 min (3 h in pause not counted)");
  });
});

describe("factory CLI", () => {
  it("should exit zero on a valid spec when validating, taking the target repo from the current directory", async () => {
    const repoDir = await targetRepo(await valid());
    const { env, out } = cli(repoDir);

    expect(await main(["validate", "42"], env)).toBe(0);
    expect(out.join("\n")).toContain(`specs/42.md on ${BRANCH} is valid`);
  });

  it("should exit non-zero and list the problems of an invalid spec", async () => {
    const repoDir = await targetRepo("# Spec\n\nNo block.\n");
    const { env, err } = cli(await temp.make("elsewhere-"));

    expect(await main(["validate", "42", repoDir], env)).toBe(1);
    expect(err.join("\n")).toContain("the spec must hold exactly one ```json factory-spec block, found 0");
  });

  it("should validate against the protected paths of the target repo's config", async () => {
    const repoDir = await targetRepo(await valid(), CONFIG.replace('["package.json"]', '["src/search/"]'));
    const { env, err } = cli(repoDir);

    expect(await main(["validate", "42"], env)).toBe(1);
    expect(err.join("\n")).toContain("subtask list has the protected path src/search/ in its scope");
  });

  it("should exit non-zero when the target repo has no config, because validation needs its protected paths", async () => {
    const repoDir = await targetRepo(await valid(), null);
    const { env, err } = cli(repoDir);

    expect(await main(["validate", "42"], env)).toBe(1);
    expect(err.join("\n")).toContain(`${join(repoDir, ".factory", "config.ts")} does not exist`);
  });

  it("should approve a valid spec and say where it committed", async () => {
    const repoDir = await targetRepo(await valid());
    const { env, out } = cli(repoDir);

    expect(await main(["approve", "42"], env)).toBe(0);
    expect(out.join("\n")).toContain(`Approved spec #42 on ${BRANCH}`);
    expect(readApproval(await readFile(join(repoDir, "specs", "42.md"), "utf8")).kind).toBe("approved");
  });

  it("should run an approved spec and print the link of the pull request", async () => {
    const repoDir = await targetRepo(ONE_SUBTASK_SPEC);
    const remoteDir = await temp.make("cli-remote-");
    await execOk("git", ["init", "-q", "--bare", remoteDir]);
    await git(repoDir, "remote", "add", "origin", remoteDir);
    await git(repoDir, "branch", "main");
    await git(repoDir, "push", "-q", "origin", "main");
    await git(repoDir, "remote", "set-head", "origin", "--auto");
    const { env, out, notifier } = cli(repoDir);
    expect(await main(["approve", "42"], env)).toBe(0);

    expect(await main(["run", "42"], env)).toBe(0);

    expect(out.join("\n")).toContain("Pull request: https://github.test/pull/100");
    expect(notifier.sent).toHaveLength(1);
  });

  it("should exit non-zero and start no worker when the spec to run is not approved", async () => {
    const repoDir = await targetRepo(ONE_SUBTASK_SPEC);
    const { env, err, runner } = cli(repoDir);

    expect(await main(["run", "42"], env)).toBe(1);
    expect(err.join("\n")).toContain("specs/42.md is not approved; run factory approve 42 first");
    expect(runner.workers).toEqual([]);
  });

  it("should exit non-zero with a clear message when the integration branch does not exist", async () => {
    const repoDir = await targetRepo(await valid());
    const { env, err } = cli(repoDir);

    expect(await main(["approve", "7"], env)).toBe(1);
    expect(err.join("\n")).toContain("no integration branch factory/7-<slug>");
  });

  it("should exit non-zero with a clear message, before any worker starts, when Docker is not available", async () => {
    const repoDir = await runnableRepo();
    const { env, err, runner } = cli(repoDir);
    expect(await main(["approve", "42"], env)).toBe(0);

    const code = await main(["run", "42"], { ...env, docker: () => dockerProblem("factory-test-no-such-docker") });

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("factory: Docker is not available");
    expect(runner.workers).toHaveLength(0);
    expect(existsSync(join(repoDir, ".factory", "logs"))).toBe(false);
  });

  it("should exit non-zero before it loads the config, asks any role or starts a worker when gh reports a problem", async () => {
    const repoDir = await temp.make("cli-no-gh-");
    const { env, err, runner } = cli(repoDir);
    const questions: RoleEntry[][] = [];
    env.ask = async (entries) => {
      questions.push(entries);
      return {};
    };

    const code = await main(["run", "42"], { ...env, gh: async () => "gh is not signed in: run gh auth login" });

    expect(code).toBe(1);
    expect(err).toEqual(["factory: gh is not signed in: run gh auth login"]);
    expect(questions).toEqual([]);
    expect(runner.workers).toHaveLength(0);
    expect(existsSync(join(repoDir, ".factory", "logs"))).toBe(false);
  });

  it("should exit non-zero before any role question and any worker when gh is not ready, because the pull request needs it", async () => {
    const repoDir = await runnableRepo();
    const { env, err, runner } = cli(repoDir);
    const questions: RoleEntry[][] = [];
    expect(await main(["approve", "42"], env)).toBe(0);

    const code = await main(["run", "42"], {
      ...env,
      gh: () => ghProblem("factory-test-no-such-gh"),
      ask: async (entries) => {
        questions.push(entries);
        throw new Error("no role question is expected");
      },
    });

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("factory: gh is not available");
    expect(questions).toHaveLength(0);
    expect(runner.workers).toHaveLength(0);
    expect(existsSync(join(repoDir, ".factory", "logs"))).toBe(false);
  });

  it("should report the Docker and the gh problems together so that every missing tool shows up front", async () => {
    const repoDir = await temp.make("cli-no-tools-");
    const { env, err } = cli(repoDir);

    const code = await main(["run", "42"], { ...env, docker: async () => "Docker is not running", gh: async () => "gh is not available" });

    expect(code).toBe(1);
    expect(err).toEqual(["factory: Docker is not running", "factory: gh is not available"]);
  });

  it("should exit non-zero with a clear message when gh is missing", async () => {
    const repoDir = await targetRepo(await valid());
    const { env, err } = cli(repoDir, ghGitHub({ repoDir, command: "factory-test-no-such-gh" }));

    expect(await main(["validate", "42"], env)).toBe(1);
    expect(err.join("\n")).toContain("gh is not available");
  });

  it("should print the usage and exit non-zero on an unknown command or a bad issue number", async () => {
    const { env, err } = cli(await temp.make("cli-usage-"));

    expect(await main(["deploy", "42"], env)).toBe(2);
    expect(await main(["approve", "forty-two"], env)).toBe(2);
    expect(err.join("\n")).toContain("usage: factory <refine|approve|validate|run> <issue> [target-repo]");
  });

  it("should prepare the worktree and launch the refinement in it, exiting with the code of the session", async () => {
    const repoDir = await mainRepo();
    const { env, out, launches } = cli(repoDir, new FakeGitHub([{ number: 42, title: "Saved searches", body: "" }]));
    env.launch = async (launch) => {
      launches.push(launch);
      return 7;
    };

    expect(await main(["refine", "42", ...CLAUDE_REFINEMENT], env)).toBe(7);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.cwd).toBe(join(repoDir, ".factory", "worktrees", "42-saved-searches"));
    expect(launches[0]?.args).toContain("/factory:refine 42");
    expect(out.join("\n")).toContain("Created factory/42-saved-searches");
  });

  it("should launch the refinement with the model of --refinement-agent, over the config", async () => {
    const repoDir = await mainRepo();
    await mkdir(join(repoDir, ".factory"));
    await writeFile(join(repoDir, ".factory", "config.ts"), WITH_REFINEMENT);
    const { env, launches } = cli(repoDir, new FakeGitHub([{ number: 42, title: "Saved searches", body: "" }]));

    expect(await main(["refine", "42", "--refinement-agent", "claude-code:haiku"], env)).toBe(0);

    expect(launches[0]?.command).toBe("claude");
    expect(modelOf(launches[0])).toBe("haiku");
  });

  it("should launch the refinement with the model of the flag when the config does not exist", async () => {
    const { env, launches } = cli(await mainRepo(), new FakeGitHub([{ number: 42, title: "x", body: "" }]));

    expect(await main(["refine", "42", ...CLAUDE_REFINEMENT], env)).toBe(0);

    expect(modelOf(launches[0])).toBe("sonnet");
  });

  it("should take the model of the refinement from roles.refinement of the config with no flag and no terminal", async () => {
    const repoDir = await mainRepo();
    await mkdir(join(repoDir, ".factory"));
    await writeFile(join(repoDir, ".factory", "config.ts"), WITH_REFINEMENT);
    const { env, launches } = cli(repoDir, new FakeGitHub([{ number: 42, title: "Saved searches", body: "" }]));

    expect(await main(["refine", "42"], env)).toBe(0);

    expect(modelOf(launches[0])).toBe("opus");
  });

  it("should refuse to start, naming the flag and the config key, when neither gives the refinement an agent", async () => {
    const withoutKey = await mainRepo();
    await mkdir(join(withoutKey, ".factory"));
    await writeFile(join(withoutKey, ".factory", "config.ts"), CONFIG);
    const bare = await mainRepo();
    const first = cli(withoutKey);
    const second = cli(bare);

    expect(await main(["refine", "42"], first.env)).toBe(1);
    expect(await main(["refine", "42"], second.env)).toBe(1);

    for (const { err, launches } of [first, second]) {
      expect(err.join("\n")).toContain("--refinement-agent");
      expect(err.join("\n")).toContain("roles.refinement");
      expect(launches).toHaveLength(0);
    }
    expect(existsSync(join(withoutKey, ".factory", "worktrees"))).toBe(false);
  });

  it("should reject an OpenCode refinement, which cannot start the refinement skill, before any worktree or launch", async () => {
    const repoDir = await mainRepo();
    const { env, err, launches } = cli(repoDir);

    expect(await main(["refine", "42", "--refinement-agent", "opencode:opencode-go/kimi-k3"], env)).toBe(1);

    expect(err.join("\n")).toContain("opencode cannot serve the refinement");
    expect(launches).toHaveLength(0);
    expect(existsSync(join(repoDir, ".factory", "worktrees"))).toBe(false);
  });

  it("should reject an OpenCode refinement that the config names, as it does for the other roles", async () => {
    const repoDir = await mainRepo();
    await mkdir(join(repoDir, ".factory"));
    await writeFile(join(repoDir, ".factory", "config.ts"), WITH_REFINEMENT.replace('agent: "claude-code", model: "opus"', 'agent: "opencode", model: "opencode-go/kimi-k3"'));
    const { env, err, launches } = cli(repoDir);

    expect(await main(["refine", "42"], env)).toBe(1);

    expect(err.join("\n")).toContain("roles.refinement: opencode cannot serve the refinement");
    expect(launches).toHaveLength(0);
  });

  it("should ask in a terminal with a menu of the refinement alone that offers only Claude Code, and launch with the model it gives", async () => {
    const repoDir = await mainRepo();
    await mkdir(join(repoDir, ".factory"));
    await writeFile(join(repoDir, ".factory", "config.ts"), WITH_REFINEMENT);
    const { env, launches } = cli(repoDir, new FakeGitHub([{ number: 42, title: "Saved searches", body: "" }]));
    const asked: RoleEntry[][] = [];
    env.ask = async (entries) => {
      asked.push(entries);
      return { refinement: { agent: "claude-code", model: "haiku" } };
    };

    expect(await main(["refine", "42"], env)).toBe(0);

    expect(asked).toEqual([
      [{ role: "refinement", offered: ["claude-code"], choice: { agent: "claude-code", model: "opus" }, origin: "config" }],
    ]);
    expect(modelOf(launches[0])).toBe("haiku");
  });

  it("should not ask when --refinement-agent fixes the refinement", async () => {
    const { env, launches } = cli(await mainRepo(), new FakeGitHub([{ number: 42, title: "x", body: "" }]));
    env.ask = async () => {
      throw new Error("no question is expected");
    };

    expect(await main(["refine", "42", ...CLAUDE_REFINEMENT], env)).toBe(0);
    expect(launches).toHaveLength(1);
  });

  it("should refuse the role flags of a run in refine and --refinement-agent in run and approve, with the usage", async () => {
    const { env, err, launches, runner } = cli(await mainRepo());

    expect(await main(["refine", "42", "--worker-agent", "claude-code:opus"], env)).toBe(2);
    expect(await main(["refine", "42", "--tester-agent", "claude-code:opus"], env)).toBe(2);
    expect(await main(["run", "42", ...CLAUDE_REFINEMENT], env)).toBe(2);
    expect(await main(["approve", "42", ...CLAUDE_REFINEMENT], env)).toBe(2);

    expect(err.every((line) => line.includes("usage: factory"))).toBe(true);
    expect(launches).toHaveLength(0);
    expect(runner.workers).toHaveLength(0);
  });

  it("should say that it reuses the branch and launch again when the worktree already exists", async () => {
    const repoDir = await mainRepo();
    const { env, out, launches } = cli(repoDir, new FakeGitHub([{ number: 42, title: "Saved searches", body: "" }]));

    expect(await main(["refine", "42", ...CLAUDE_REFINEMENT], env)).toBe(0);
    expect(await main(["refine", "42", ...CLAUDE_REFINEMENT], env)).toBe(0);
    expect(launches).toHaveLength(2);
    expect(out.join("\n")).toContain("Reusing factory/42-saved-searches");
  });

  it("should not launch when the issue cannot be read", async () => {
    const { env, err, launches } = cli(await mainRepo(), new FakeGitHub([]));

    expect(await main(["refine", "42", ...CLAUDE_REFINEMENT], env)).toBe(1);
    expect(launches).toHaveLength(0);
    expect(err.join("\n")).toContain("issue #42 does not exist");
  });
});

describe("factory CLI: the default branch of the target repo", () => {
  async function bareRemote(repoDir: string, head: string): Promise<string> {
    const remoteDir = await temp.make("cli-remote-");
    await execOk("git", ["init", "-q", "--bare", "-b", head, remoteDir]);
    await git(repoDir, "remote", "set-url", "origin", remoteDir).catch(() => git(repoDir, "remote", "add", "origin", remoteDir));
    return remoteDir;
  }

  const saved = () => new FakeGitHub([{ number: 42, title: "Saved searches", body: "" }]);

  it("should start the integration branch from the local copy of the default branch that origin/HEAD names, with no fetch", async () => {
    const repoDir = await mainRepo();
    await git(repoDir, "branch", "-m", "main", "trunk");
    await bareRemote(repoDir, "trunk");
    await git(repoDir, "push", "-q", "origin", "trunk");
    await git(repoDir, "remote", "set-head", "origin", "--auto");
    await git(repoDir, "commit", "-q", "--allow-empty", "-m", "Only on the local trunk");
    const { env } = cli(repoDir, saved());

    expect(await main(["refine", "42", ...CLAUDE_REFINEMENT], env)).toBe(0);

    const worktree = join(repoDir, ".factory", "worktrees", "42-saved-searches");
    expect(await git(worktree, "rev-parse", "HEAD")).toBe(await git(repoDir, "rev-parse", "trunk"));
    expect(await git(worktree, "rev-parse", "HEAD")).not.toBe(await git(repoDir, "rev-parse", "origin/trunk"));
  });

  it("should ask GitHub for a pull request whose base is the default branch", async () => {
    const repoDir = await targetRepo(ONE_SUBTASK_SPEC);
    await bareRemote(repoDir, "trunk");
    await git(repoDir, "branch", "trunk");
    await git(repoDir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    const github = new FakeGitHub([{ number: 42, title: "x", body: issueBody }]);
    const { env } = cli(repoDir, github);
    expect(await main(["approve", "42"], env)).toBe(0);

    expect(await main(["run", "42"], env)).toBe(0);

    expect(github.pullRequests.map((pullRequest) => pullRequest.base)).toEqual(["trunk"]);
  });

  it("should stop refine and run with the command that sets origin/HEAD when it is not set, as after git remote add", async () => {
    const refineRepo = await mainRepo();
    await git(refineRepo, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    const refining = cli(refineRepo, saved());
    const runRepo = await targetRepo(ONE_SUBTASK_SPEC);
    await bareRemote(runRepo, "main");
    await git(runRepo, "branch", "main");
    await git(runRepo, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    const running = cli(runRepo);
    expect(await main(["approve", "42"], running.env)).toBe(0);

    expect(await main(["refine", "42", ...CLAUDE_REFINEMENT], refining.env)).toBe(1);
    expect(await main(["run", "42"], running.env)).toBe(1);

    expect(refining.err.join("\n")).toContain("origin/HEAD is not set");
    expect(refining.err.join("\n")).toContain("git remote set-head origin --auto");
    expect(running.err.join("\n")).toContain("git remote set-head origin --auto");
    expect(refining.launches).toHaveLength(0);
    expect(running.runner.workers).toHaveLength(0);
  });

  it("should stop refine and run with a message of its own when the default branch has no local copy", async () => {
    const refineRepo = await mainRepo();
    await git(refineRepo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    const refining = cli(refineRepo, saved());
    const runRepo = await targetRepo(ONE_SUBTASK_SPEC);
    await bareRemote(runRepo, "main");
    const running = cli(runRepo);
    expect(await main(["approve", "42"], running.env)).toBe(0);

    expect(await main(["refine", "42", ...CLAUDE_REFINEMENT], refining.env)).toBe(1);
    expect(await main(["run", "42"], running.env)).toBe(1);

    expect(refining.err.join("\n")).toContain("the default branch trunk has no local copy");
    expect(running.err.join("\n")).toContain("the default branch main has no local copy");
    expect(running.runner.workers).toHaveLength(0);
  });
});

describe("factory run: the notice of an abandoned run", () => {
  const NOW = new Date("2026-10-24T08:00:00.000Z");

  function clockTime(at: Date): string {
    return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  }

  async function previousRun(repoDir: string, silentMs: number) {
    const lastChange = new Date(NOW.getTime() - silentMs);
    const run = await writeRunningRun({ logsDir: join(repoDir, ".factory", "logs"), issue: 42, runJsonAt: lastChange, logAt: lastChange });
    return { run, lastChange };
  }

  it("should print which run was abandoned and when before the menu, and start a new run", async () => {
    const repoDir = await runnableRepo();
    const { env, out } = cli(repoDir);
    expect(await main(["approve", "42"], env)).toBe(0);
    const { run, lastChange } = await previousRun(repoDir, 30 * 60_000);
    const seenByMenu: string[] = [];
    env.ask = async () => {
      seenByMenu.push(...out);
      return {};
    };

    expect(await main(["run", "42"], env)).toBe(0);

    const notice = `run ${run.runId} of #42 was abandoned at ${clockTime(lastChange)}; starting a new run`;
    expect(seenByMenu).toContain(notice);
    expect(out.indexOf(notice)).toBeLessThan(out.indexOf("Preparing run #42; factory web shows it at http://127.0.0.1:7433/"));
    expect((await lastRunLog(repoDir)).runId).not.toBe(run.runId);
  });

  it("should take the threshold from the run log, so a run that recorded a longer silence is not called abandoned", async () => {
    const repoDir = await runnableRepo();
    const { env, out } = cli(repoDir);
    expect(await main(["approve", "42"], env)).toBe(0);
    const lastChange = new Date(NOW.getTime() - 30 * 60_000);
    await writeRunningRun({
      logsDir: join(repoDir, ".factory", "logs"),
      issue: 42,
      runJsonAt: lastChange,
      logAt: lastChange,
      attemptIdleTimeoutMs: 3_600_000,
    });

    expect(await main(["run", "42"], env)).toBe(0);

    expect(out.some((line) => line.includes("was abandoned"))).toBe(false);
  });

  it("should not warn about a run that is still working", async () => {
    const repoDir = await runnableRepo();
    const { env, out } = cli(repoDir);
    expect(await main(["approve", "42"], env)).toBe(0);
    await previousRun(repoDir, 60_000);

    expect(await main(["run", "42"], env)).toBe(0);

    expect(out.some((line) => line.includes("was abandoned"))).toBe(false);
  });

  it("should not warn when the last run of the issue finished", async () => {
    const repoDir = await runnableRepo();
    const { env, out } = cli(repoDir);
    expect(await main(["approve", "42"], env)).toBe(0);
    expect(await main(["run", "42"], env)).toBe(0);
    out.length = 0;

    expect(await main(["run", "42"], env)).toBe(0);

    expect(out.some((line) => line.includes("was abandoned"))).toBe(false);
  });
});
