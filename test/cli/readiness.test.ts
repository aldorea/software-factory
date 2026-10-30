import { describe, expect, it } from "vitest";
import {
  gatherProbes,
  neededProbes,
  readiness,
  readinessProblems,
  type Probes,
  type ReadinessCommand,
  type ReadinessFacts,
} from "../../src/cli/readiness.ts";

const READY: ReadinessFacts = {
  probes: { docker: null, gh: null, claudeSession: null, originHead: null, workerImage: null },
  roles: {
    workers: { agent: "claude-code", model: "sonnet" },
    verifier: { agent: "claude-code", model: "opus" },
    tester: { agent: "claude-code", model: "sonnet" },
  },
  credentials: { "claude-code": "token" },
};

function facts(change: Partial<ReadinessFacts> & { probes?: ReadinessFacts["probes"] }): ReadinessFacts {
  return { ...READY, ...change, probes: { ...READY.probes, ...change.probes } };
}

function failures(command: ReadinessCommand, given: ReadinessFacts) {
  return readiness(command, given).filter((result) => result.kind === "fail");
}

describe("readiness of factory refine", () => {
  it("should pass when gh, the Claude Code session and origin/HEAD are all fine", () => {
    expect(failures("refine", READY)).toEqual([]);
  });

  it("should fail with gh auth login when gh has no session", () => {
    expect(failures("refine", facts({ probes: { gh: "gh is not signed in" } }))).toEqual([
      { kind: "fail", text: "gh is not signed in", command: "gh auth login" },
    ]);
  });

  it("should fail with claude auth login when the Claude Code session of the host is missing", () => {
    expect(failures("refine", facts({ probes: { claudeSession: "the Claude Code session of this host is not signed in" } }))).toEqual([
      { kind: "fail", text: "the Claude Code session of this host is not signed in", command: "claude auth login" },
    ]);
  });

  it("should fail with the set-head command when origin/HEAD is not set", () => {
    expect(failures("refine", facts({ probes: { originHead: "origin/HEAD is not set" } }))).toEqual([
      { kind: "fail", text: "origin/HEAD is not set", command: "git remote set-head origin --auto" },
    ]);
  });

  it("should not check Docker or any credential, because refine runs on the host", () => {
    const broken = facts({ probes: { docker: "Docker is not running" }, credentials: {} });

    expect(failures("refine", broken)).toEqual([]);
  });

  it("should list every problem at once, not only the first", () => {
    const broken = facts({ probes: { gh: "gh is not signed in", claudeSession: "no session", originHead: "origin/HEAD is not set" } });

    expect(failures("refine", broken).map((result) => result.command)).toEqual([
      "gh auth login",
      "claude auth login",
      "git remote set-head origin --auto",
    ]);
  });
});

describe("readiness of factory run", () => {
  it("should pass when Docker, gh and the credentials of the chosen roles are fine", () => {
    expect(failures("run", READY)).toEqual([]);
  });

  it("should fail Docker with no command, because nothing the factory can type starts it", () => {
    expect(failures("run", facts({ probes: { docker: "Docker is not running" } }))).toEqual([
      { kind: "fail", text: "Docker is not running" },
    ]);
  });

  it("should fail with gh auth login when gh has no session", () => {
    expect(failures("run", facts({ probes: { gh: "gh is not signed in" } }))).toEqual([
      { kind: "fail", text: "gh is not signed in", command: "gh auth login" },
    ]);
  });

  it("should name the role and the agent, and the command that saves the credential, when a chosen agent has none", () => {
    const given = facts({
      roles: { workers: { agent: "claude-code", model: "sonnet" }, verifier: { agent: "opencode", model: "opencode-go/kimi-k2" } },
    });

    expect(failures("run", given)).toEqual([
      { kind: "fail", text: "OPENCODE_API_KEY not set; roles.verifier uses opencode", command: "factory auth opencode" },
    ]);
  });

  it("should group the roles that share an agent without a credential into one problem", () => {
    const given = facts({ credentials: {} });

    expect(failures("run", given)).toEqual([
      {
        kind: "fail",
        text: "CLAUDE_CODE_OAUTH_TOKEN not set; roles.workers, roles.verifier and roles.tester use claude-code",
        command: "factory auth claude-code",
      },
    ]);
  });

  it("should not ask for the credential of an agent that no chosen role uses", () => {
    const given = facts({ credentials: {}, roles: {} });

    expect(failures("run", given)).toEqual([]);
  });

  it("should treat an empty credential as missing", () => {
    expect(failures("run", facts({ credentials: { "claude-code": "" } }))).toHaveLength(1);
  });

  it("should not check the Claude Code session or origin/HEAD, which belong to refine", () => {
    const broken = facts({ probes: { claudeSession: "no session", originHead: "origin/HEAD is not set" } });

    expect(failures("run", broken)).toEqual([]);
  });

  it("should fail with factory image when the worker image is missing or built from an older base image", () => {
    const stale = facts({ probes: { workerImage: "mi-repo-factory-worker:dev built from an older base image" } });

    expect(failures("run", stale)).toEqual([
      { kind: "fail", text: "mi-repo-factory-worker:dev built from an older base image", command: "factory image" },
    ]);
  });

  it("should not report the worker image while Docker is down, because the Docker problem already explains it", () => {
    const down = facts({ probes: { docker: "Docker is not running", workerImage: "worker:dev not built" } });

    expect(failures("run", down)).toEqual([{ kind: "fail", text: "Docker is not running" }]);
  });

  it("should not check the worker image for refine, which runs on the host", () => {
    expect(failures("refine", facts({ probes: { workerImage: "worker:dev not built" } }))).toEqual([]);
  });

  it("should list a tool problem and a credential problem together", () => {
    const given = facts({ probes: { docker: "Docker is not running", gh: "gh is not signed in" }, credentials: {} });

    expect(failures("run", given).map((result) => result.command)).toEqual([undefined, "gh auth login", "factory auth claude-code"]);
  });
});

describe("readiness results", () => {
  it("should report a passed check as ok, so that a doctor can list what is fine", () => {
    expect(readiness("refine", READY).map((result) => result.kind)).toEqual(["ok", "ok", "ok"]);
  });

  it("should keep only the failures as setup lines with their fix", () => {
    const lines = readinessProblems(readiness("refine", facts({ probes: { gh: "gh is not signed in" } })));

    expect(lines).toEqual([{ kind: "fail", text: "gh is not signed in", command: "gh auth login" }]);
  });

  it("should refuse to evaluate a check whose probe was not run, so that a missing fact never counts as fine", () => {
    expect(() => readiness("refine", { ...READY, probes: {} })).toThrow("the gh probe was not run");
  });
});

describe("probes a command needs", () => {
  const silent: Probes = {
    docker: async () => "docker",
    gh: async () => "gh",
    claudeSession: async () => "claude",
    originHead: async () => "origin",
    workerImage: async () => "image",
  };

  it("should list only the probes of the checks of that command", () => {
    expect(neededProbes("refine").sort()).toEqual(["claudeSession", "gh", "originHead"]);
    expect(neededProbes("run").sort()).toEqual(["docker", "gh", "workerImage"]);
  });

  it("should run only those probes", async () => {
    expect(await gatherProbes("run", silent)).toEqual({ docker: "docker", gh: "gh", workerImage: "image" });
  });
});
