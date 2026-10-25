import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, DEFAULT_READY_TIMEOUT_MS } from "../../src/config/config.ts";
import { loadConfig } from "../../src/config/load.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

const VALID = `
const config = {
  image: "askwell-worker:dev",
  checks: [{ name: "typecheck", command: "pnpm typecheck" }],
  app: { start: "pnpm dev" },
  environment: ({ slot }) => ({ E2E_PORT: String(4000 + slot) }),
  protectedPaths: ["package.json", "pnpm-lock.yaml"],
  roles: {
    workers: { agent: "claude-code", model: "sonnet" },
    verifier: { agent: "opencode", model: "opencode-go/kimi-k2" },
  },
  agents: { "claude-code": { maxParallel: 2 } },
};

export default config;
`;

async function repoWithConfig(source: string | null): Promise<string> {
  const dir = await temp.make("config-");
  if (source !== null) {
    await mkdir(join(dir, ".factory"));
    await writeFile(join(dir, ".factory", "config.ts"), source);
  }
  return dir;
}

describe("loadConfig", () => {
  it("should load the config and fill the limits it does not set with the defaults of the design", async () => {
    const dir = await repoWithConfig(VALID);

    const config = await loadConfig(dir);

    expect(config.image).toBe("askwell-worker:dev");
    expect(config.checks).toEqual([{ name: "typecheck", command: "pnpm typecheck" }]);
    expect(config.app).toEqual({ start: "pnpm dev", readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS });
    expect(config.protectedPaths).toEqual(["package.json", "pnpm-lock.yaml"]);
    expect(config.roles.workers).toEqual({ agent: "claude-code", model: "sonnet" });
    expect(config.environment({ purpose: "worker", subtask: "S1", slot: 1 })).toEqual({ E2E_PORT: "4001" });
    expect(config.agents["claude-code"]).toEqual({ ...DEFAULT_LIMITS.agents["claude-code"], maxParallel: 2 });
    expect(config.agents.opencode).toEqual(DEFAULT_LIMITS.agents.opencode);
    expect(config.limits).toEqual(DEFAULT_LIMITS.run);
  });

  it("should fail closed with the path when the config is missing", async () => {
    const dir = await repoWithConfig(null);

    await expect(loadConfig(dir)).rejects.toThrow(`${join(dir, ".factory", "config.ts")} does not exist`);
  });

  it("should fail with the module error when the config does not load", async () => {
    const dir = await repoWithConfig("export default {;\n");

    await expect(loadConfig(dir)).rejects.toThrow(`${join(dir, ".factory", "config.ts")} does not load`);
  });

  it("should name every problem of an invalid config instead of running with a guess", async () => {
    const dir = await repoWithConfig(
      'export default { image: "", checks: [], environment: {}, protectedPaths: "package.json", roles: { workers: { agent: "codex", model: "x" } } };\n',
    );

    const error = await loadConfig(dir).then(
      () => "",
      (caught: Error) => caught.message,
    );

    expect(error).toContain("is invalid");
    expect(error).toContain("- image must be a non-empty string");
    expect(error).toContain("- checks must list at least one check");
    expect(error).toContain("- environment must be a function from the worker to its environment");
    expect(error).toContain("- protectedPaths must be a list of strings");
    expect(error).toContain("- roles.workers.agent must be one of claude-code, opencode");
    expect(error).not.toContain("roles.verifier");
  });

  it("should refuse a default agent that cannot serve its role, because the hard limits and the pause would not apply to it", async () => {
    const dir = await repoWithConfig(
      VALID.replace('workers: { agent: "claude-code", model: "sonnet" }', 'workers: { agent: "opencode", model: "opencode-go/kimi-k2" }'),
    );

    await expect(loadConfig(dir)).rejects.toThrow(
      "roles.workers: opencode cannot serve the workers: it misses detectsPlanLimit",
    );
  });

  it("should load a config with no default agents, because the flags or the prompt of factory run can give them", async () => {
    const dir = await repoWithConfig(VALID.replace(/  roles: \{[\s\S]*?\n  \},\n/, ""));

    expect((await loadConfig(dir)).roles).toEqual({});
  });

  it("should load the e2e and request commands with the placeholder of the criterion ID and default to no commands", async () => {
    const withEvidence = VALID.replace(
      "  app:",
      '  evidence: { playwright: "pnpm e2e -g {{id}}", request: "pnpm request {{id}}", attachments: "test-results" },\n  app:',
    );

    expect((await loadConfig(await repoWithConfig(withEvidence))).evidence).toEqual({
      playwright: "pnpm e2e -g {{id}}",
      request: "pnpm request {{id}}",
      attachments: "test-results",
    });
    expect((await loadConfig(await repoWithConfig(VALID))).evidence).toEqual({});
  });

  it("should refuse an evidence command with no placeholder and an attachments folder outside the repo", async () => {
    const dir = await repoWithConfig(
      VALID.replace("  app:", '  evidence: { request: "pnpm request", attachments: "../outside" },\n  app:'),
    );

    const error = await loadConfig(dir).then(
      () => "",
      (caught: Error) => caught.message,
    );

    expect(error).toContain("- evidence.request must be a command with the {{id}} placeholder for the criterion ID");
    expect(error).toContain("- evidence.attachments must be a folder inside the repo, as a relative path");
  });

  it("should load the readiness command of the app and default its timeout", async () => {
    const withReady = VALID.replace('app: { start: "pnpm dev" }', 'app: { start: "pnpm dev", ready: "curl -sf localhost:3000" }');

    expect((await loadConfig(await repoWithConfig(withReady))).app).toEqual({
      start: "pnpm dev",
      ready: "curl -sf localhost:3000",
      readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
    });
    expect((await loadConfig(await repoWithConfig(VALID))).app).toEqual({ start: "pnpm dev", readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS });
  });

  it("should refuse an empty readiness command, a timeout that is not positive and an unknown app setting", async () => {
    const dir = await repoWithConfig(
      VALID.replace('app: { start: "pnpm dev" }', 'app: { start: "pnpm dev", ready: " ", readyTimeoutMs: 0, port: 3000 }'),
    );

    const error = await loadConfig(dir).then(
      () => "",
      (caught: Error) => caught.message,
    );

    expect(error).toContain("- app.ready must be a non-empty command that exits zero once the app serves");
    expect(error).toContain("- app.readyTimeoutMs must be a positive number");
    expect(error).toContain("- app.port is not a known setting");
  });

  it("should load the config again after it changes in the same process", async () => {
    const dir = await repoWithConfig(VALID);
    await loadConfig(dir);
    await writeFile(join(dir, ".factory", "config.ts"), VALID.replace("askwell-worker:dev", "askwell-worker:v2"));

    expect((await loadConfig(dir)).image).toBe("askwell-worker:v2");
  });
});
