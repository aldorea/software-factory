import { describe, expect, it } from "vitest";
import { readiness, readinessLines, type ReadinessFacts } from "../../src/cli/readiness.ts";

const READY: ReadinessFacts = {
  probes: { docker: null, gh: null, claudeSession: null, originHead: null, workerImage: null, node: null, config: null },
  roles: {
    workers: { agent: "claude-code", model: "sonnet" },
    verifier: { agent: "claude-code", model: "opus" },
    tester: { agent: "claude-code", model: "sonnet" },
  },
  credentials: { "claude-code": "token" },
  env: { variables: ["FACTORY_E2E_DATABASE_URL_0"], values: { FACTORY_E2E_DATABASE_URL_0: "postgres://x" } },
  dockerignore: ".env\n",
};

function facts(change: Partial<ReadinessFacts> & { probes?: ReadinessFacts["probes"] }): ReadinessFacts {
  return { ...READY, ...change, probes: { ...READY.probes, ...change.probes } };
}

function failures(given: ReadinessFacts) {
  return readiness("doctor", given).filter((result) => result.kind === "fail");
}

describe("readiness of factory doctor", () => {
  it("should list every check that passes, with no failure, when the host and the repo are ready", () => {
    expect(readiness("doctor", READY)).toEqual([
      { kind: "ok", text: "Node is at the floor of engines in package.json" },
      { kind: "ok", text: "Docker is running" },
      { kind: "ok", text: "gh is signed in" },
      { kind: "ok", text: "the Claude Code session of the host is signed in" },
      { kind: "ok", text: ".factory/config.ts loads" },
      { kind: "ok", text: ".factory/.env has every value of .factory/.env.example" },
      { kind: "ok", text: ".factory/.dockerignore excludes .env from the build context" },
      { kind: "ok", text: "origin/HEAD is set" },
      { kind: "ok", text: "CLAUDE_CODE_OAUTH_TOKEN is set for claude-code" },
      { kind: "ok", text: "the worker image is built from the current base image" },
    ]);
  });

  it("should fail on a Node older than the floor", () => {
    expect(failures(facts({ probes: { node: "Node 22.1.0 is older than 24.22.1" } }))).toEqual([
      { kind: "fail", text: "Node 22.1.0 is older than 24.22.1" },
    ]);
  });

  it("should check every probe of run and refine, so that doctor lists their problems too", () => {
    const broken = facts({
      probes: {
        docker: "Docker is not running",
        gh: "gh is not signed in",
        claudeSession: "no session",
        originHead: "origin/HEAD is not set",
      },
    });

    expect(failures(broken).map((result) => result.command)).toEqual([
      undefined,
      "gh auth login",
      "claude auth login",
      "git remote set-head origin --auto",
    ]);
  });

  it("should report a config that does not load, and skip the worker image whose name only the config holds", () => {
    const broken = facts({ probes: { config: ".factory/config.ts is invalid: image must be a string", workerImage: null } });

    expect(readiness("doctor", broken).filter((result) => result.text.includes("worker image"))).toEqual([]);
    expect(failures(broken)).toEqual([{ kind: "fail", text: ".factory/config.ts is invalid: image must be a string" }]);
  });

  it("should fail with the copy command when .factory/.env does not exist but .env.example lists variables", () => {
    const missing = facts({ env: { variables: ["A_0", "A_1"], values: null } });

    expect(failures(missing)).toEqual([
      {
        kind: "fail",
        text: ".factory/.env does not exist; .factory/.env.example lists A_0, A_1",
        command: "cp .factory/.env.example .factory/.env",
      },
    ]);
  });

  it("should name every variable of .env.example that .factory/.env leaves missing or empty", () => {
    const partial = facts({ env: { variables: ["A_0", "A_1", "A_2"], values: { A_0: "x", A_1: "" } } });

    expect(failures(partial)).toEqual([
      { kind: "fail", text: ".factory/.env has no value for A_1, A_2", command: "edit .factory/.env" },
    ]);
  });

  it("should not ask anything of .factory/.env when .env.example lists no variable", () => {
    const none = facts({ env: { variables: [], values: null } });

    expect(readiness("doctor", none).filter((result) => result.text.includes(".factory/.env"))).toEqual([]);
  });

  it("should check the credential of the agents of the workers, verifier and tester only, because refinement runs on the host", () => {
    const given = facts({
      credentials: { "claude-code": "token" },
      roles: { workers: { agent: "claude-code", model: "sonnet" }, refinement: { agent: "opencode", model: "opencode-go/x" } },
    });

    expect(failures(given)).toEqual([]);
  });

  it("should fail the credential of an agent that the roles of the config use and that has none", () => {
    const given = facts({
      credentials: { "claude-code": "token" },
      roles: { workers: { agent: "claude-code", model: "sonnet" }, verifier: { agent: "opencode", model: "opencode-go/x" } },
    });

    expect(failures(given)).toEqual([
      { kind: "fail", text: "OPENCODE_API_KEY not set; roles.verifier uses opencode", command: "factory auth opencode" },
    ]);
  });

  it("should show a broken credentials file as one failure with its chmod fix, and not guess which credentials are missing", () => {
    const file = "/home/me/.config/software-factory/credentials";
    const given = facts({
      credentials: {},
      credentialsProblem: { problem: `${file} can be read by other users (mode 644)`, fix: `chmod 600 ${file}` },
    });

    expect(failures(given)).toEqual([
      { kind: "fail", text: `${file} can be read by other users (mode 644)`, command: `chmod 600 ${file}` },
    ]);
  });

  it("should keep the text of a credentials file problem that has no command to fix it", () => {
    const given = facts({ credentials: {}, credentialsProblem: { problem: "/c line 2 is not understood: fix the line or delete it" } });

    expect(failures(given)).toEqual([{ kind: "fail", text: "/c line 2 is not understood: fix the line or delete it" }]);
  });

  it("should fail with factory init when .factory/.dockerignore does not exist, since the build context of the worker image would hold .factory/.env", () => {
    expect(failures(facts({ dockerignore: null }))).toEqual([
      { kind: "fail", text: ".factory/.dockerignore does not exist, so the build context would hold .factory/.env", command: "factory init" },
    ]);
  });

  it("should fail without factory init when .factory/.dockerignore does not exclude .env, because factory init never overwrites the file", () => {
    expect(failures(facts({ dockerignore: "node_modules\n" }))).toEqual([
      {
        kind: "fail",
        text: ".factory/.dockerignore does not exclude .env, so the build context would hold .factory/.env",
        command: "add .env to .factory/.dockerignore",
      },
    ]);
  });

  it("should refuse to evaluate the .dockerignore check when the file was not read", () => {
    const { dockerignore: _unread, ...unread } = READY;

    expect(() => readiness("doctor", unread)).toThrow("the .dockerignore file was not read");
  });

  it("should refuse to evaluate the .env check when the .env facts were not read", () => {
    const { probes, roles, credentials } = READY;

    expect(() => readiness("doctor", { probes, roles, credentials })).toThrow("the .env facts were not read");
  });

  it("should not run the doctor-only checks for run", () => {
    expect(readiness("run", READY).map((result) => result.text)).toEqual([
      "Docker is running",
      "gh is signed in",
      "CLAUDE_CODE_OAUTH_TOKEN is set for claude-code",
      "the worker image is built from the current base image",
    ]);
  });
});

describe("readiness lines", () => {
  it("should turn passed and failed checks into setup lines in order", () => {
    expect(
      readinessLines([
        { kind: "ok", text: "Docker is running" },
        { kind: "fail", text: "gh is not signed in", command: "gh auth login" },
      ]),
    ).toEqual([
      { kind: "ok", text: "Docker is running" },
      { kind: "fail", text: "gh is not signed in", command: "gh auth login" },
    ]);
  });
});
