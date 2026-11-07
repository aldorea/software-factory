import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adapterFor } from "../../src/workers/agents.ts";
import { refinementTools, type AllowedTool, type TurnPlace, type TurnRequest } from "../../src/workers/refinement-turn.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8").trim();
const initWithDefaultTools = fixture("claude-init-default.jsonl");
const initWithNoTools = fixture("claude-init-no-tools.jsonl");

const SESSION = "5c3aedb5-0a3a-4a8e-8216-71dfcf617ef6";

const place: TurnPlace = {
  issue: 42,
  repoDir: "/repos/toy",
  worktree: "/repos/toy/.factory/worktrees/42-add-login",
  factoryCli: "/factory/src/cli/factory.ts",
  pluginDir: "/factory/plugins/refinement",
};

function request(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return { place, session: null, model: "sonnet", allowedTools: refinementTools(place), ...overrides };
}

const claudeTurn = () => {
  const turn = adapterFor("claude-code").refinementTurn;
  if (turn === undefined) throw new Error("Claude Code has no refinement turn");
  return turn;
};

function argsOf(overrides: Partial<TurnRequest> = {}): string[] {
  const command = claudeTurn().command(request(overrides));
  if (!command.ok) throw new Error(command.problem);
  return command.args;
}

function valuesOf(args: readonly string[], flag: string): string[] {
  const start = args.indexOf(flag) + 1;
  const end = args.findIndex((arg, index) => index >= start && arg.startsWith("-"));
  return args.slice(start, end === -1 ? undefined : end);
}

function withTools(line: string, tools: string[]): string {
  return JSON.stringify({ ...(JSON.parse(line) as object), tools });
}

describe("the allowed tools of a turn of the refinement", () => {
  it("should be the closed list of the design: read the worktree, edit it and the holdout of the issue, and only the commands of that issue", () => {
    expect(refinementTools(place)).toEqual<AllowedTool[]>([
      { kind: "read", path: "/repos/toy/.factory/worktrees/42-add-login" },
      { kind: "edit", path: "/repos/toy/.factory/worktrees/42-add-login" },
      { kind: "edit", path: "/repos/toy/.factory/holdout/42" },
      { kind: "command", text: "gh issue view 42", more: true },
      { kind: "command", text: "gh issue edit 42", more: true },
      { kind: "command", text: "gh issue comment 42", more: true },
      { kind: "command", text: "git add specs/42.md", more: false },
      { kind: "command", text: "git commit", more: true },
      { kind: "command", text: 'node "$FACTORY_CLI" validate 42', more: false },
    ]);
  });
});

describe("the Claude Code turn of the refinement", () => {
  it("should start the refinement skill with the plugin in the first turn, as one print with a stream of JSON lines", () => {
    const args = argsOf();

    expect(args.slice(-2)).toEqual(["-p", "/factory:refine 42"]);
    expect(valuesOf(args, "--plugin-dir")).toEqual(["/factory/plugins/refinement"]);
    expect(valuesOf(args, "--output-format")).toEqual(["stream-json"]);
    expect(valuesOf(args, "--model")).toEqual(["sonnet"]);
    expect(args).not.toContain("--resume");
  });

  it("should resume the session of the conversation in the next turns and read the answer from stdin, so the answer is never an argument", () => {
    const args = argsOf({ session: SESSION });

    expect(valuesOf(args, "--resume")).toEqual([SESSION]);
    expect(args.slice(-2)).toEqual(["-p", "-"]);
  });

  it("should carry only the tools of the list in the arguments of the turn", () => {
    const args = argsOf();

    expect(valuesOf(args, "--tools")).toEqual(["Read,Glob,Grep,Edit,Write,Bash"]);
    expect(valuesOf(args, "--allowedTools")).toEqual([
      "Read(//repos/toy/.factory/worktrees/42-add-login/**)",
      "Edit(//repos/toy/.factory/worktrees/42-add-login/**)",
      "Edit(//repos/toy/.factory/holdout/42/**)",
      "Bash(gh issue view 42)",
      "Bash(gh issue view 42 *)",
      "Bash(gh issue edit 42)",
      "Bash(gh issue edit 42 *)",
      "Bash(gh issue comment 42)",
      "Bash(gh issue comment 42 *)",
      "Bash(git add specs/42.md)",
      "Bash(git commit)",
      "Bash(git commit *)",
      'Bash(node "$FACTORY_CLI" validate 42)',
    ]);
    expect(args).toContain("--strict-mcp-config");
  });

  it("should never skip the permission checks, because in a turn nobody can approve a tool and every tool outside the list must be denied", () => {
    const args = argsOf({ session: SESSION });

    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(valuesOf(args, "--permission-mode")).toEqual(["default"]);
  });

  it("should refuse the turn when the list holds a tool outside the list of the design", () => {
    const allowedTools: AllowedTool[] = [...refinementTools(place), { kind: "command", text: "rm -rf", more: true }];

    expect(claudeTurn().command(request({ allowedTools }))).toEqual({
      ok: false,
      problem: "the turn of the refinement allows only the tools of the design, and the list also holds: command rm -rf …",
    });
  });

  it("should refuse the turn when the list writes outside the worktree and the holdout of the issue", () => {
    const allowedTools: AllowedTool[] = [{ kind: "edit", path: "/repos/toy" }];

    expect(claudeTurn().command(request({ allowedTools }))).toMatchObject({ ok: false, problem: expect.stringContaining("edit /repos/toy") });
  });

  it("should refuse a session ID that is not one, so nothing read from a file becomes a flag of the agent", () => {
    expect(claudeTurn().command(request({ session: "--dangerously-skip-permissions" }))).toMatchObject({ ok: false });
  });

  it("should refuse a model that starts with a dash, so the model cannot become a flag of the agent", () => {
    expect(claudeTurn().command(request({ model: "--dangerously-skip-permissions" }))).toMatchObject({ ok: false });
  });
});

describe("the check that the list of a Claude Code turn loaded", () => {
  it("should fail closed when the init event lists the default tools, because the list did not load", () => {
    const check = claudeTurn().checker();

    expect(check.onLine(initWithDefaultTools)).toEqual({
      kind: "refused",
      problem:
        "the agent of the refinement did not load the allowed tools: it reported Task, Bash, CronCreate, CronDelete, CronList, Edit, EnterWorktree, ExitWorktree, ListAgents, NotebookEdit, Read, ReportFindings, ScheduleWakeup, SendMessage, Skill, TaskStop, ToolSearch, WebSearch, Workflow, Write instead of Read, Glob, Grep, Edit, Write, Bash",
    });
  });

  it("should fail closed when the init event lists no tools, because the list did not load either", () => {
    expect(claudeTurn().checker().onLine(initWithNoTools)).toMatchObject({ kind: "refused" });
  });

  it("should accept the turn and give its session when the init event lists exactly the tools of the list", () => {
    const line = withTools(initWithNoTools, ["Read", "Glob", "Grep", "Edit", "Write", "Bash"]);

    expect(claudeTurn().checker().onLine(line)).toEqual({ kind: "loaded", session: "ec45c53f-ae59-439a-92d2-e915e34bd922" });
  });

  it("should fail closed when the init event lists an MCP server", () => {
    const line = JSON.stringify({
      ...(JSON.parse(withTools(initWithNoTools, ["Read", "Glob", "Grep", "Edit", "Write", "Bash"])) as object),
      mcp_servers: [{ name: "github", status: "connected" }],
    });

    expect(claudeTurn().checker().onLine(line)).toMatchObject({ kind: "refused", problem: expect.stringContaining("github") });
  });

  it("should fail closed when the agent acts before it reports its tools", () => {
    const assistant = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });

    expect(claudeTurn().checker().onLine(assistant)).toEqual({
      kind: "refused",
      problem: "the agent of the refinement acted before it reported its tools, so the allowed tools cannot be checked",
    });
  });

  it("should fail closed when the agent skips the permission checks, because then the list allows nothing and denies nothing", () => {
    const workerInit = fixture("claude-activity.jsonl").split("\n")[0] ?? "";
    const line = JSON.stringify({ ...(JSON.parse(workerInit) as object), tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"], mcp_servers: [] });

    expect(claudeTurn().checker().onLine(line)).toEqual({
      kind: "refused",
      problem: "the agent of the refinement runs in the permission mode bypassPermissions, not default",
    });
  });

  it("should keep waiting on a line that is not an event", () => {
    expect(claudeTurn().checker().onLine("starting…")).toEqual({ kind: "waiting" });
  });
});

describe("an agent with no turn of the refinement", () => {
  it("should have no turn for OpenCode, which cannot refine from the web until a real run proves the refinement skill with it", () => {
    expect(adapterFor("opencode").refinementTurn).toBeUndefined();
  });
});
