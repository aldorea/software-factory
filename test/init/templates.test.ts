import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../../src/config/config.ts";
import { loadConfig } from "../../src/config/load.ts";
import {
  factoryFiles,
  renderConfig,
  renderDockerfile,
  renderDockerignore,
  renderEnvExample,
  renderPackageJson,
  type FactoryTemplateInput,
} from "../../src/init/templates.ts";
import { dockerignoreProblem } from "../../src/workers/dockerignore.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

const INPUT: FactoryTemplateInput = {
  image: "toy-factory-worker:dev",
  checks: [
    { name: "install", command: "pnpm install --frozen-lockfile" },
    { name: "lint", command: "pnpm lint" },
    { name: "test", command: "pnpm test" },
  ],
  packageManager: "pnpm",
};

async function repoWith(input: FactoryTemplateInput, env: string | null): Promise<string> {
  const dir = await temp.make("templates-");
  await mkdir(join(dir, ".factory"));
  for (const file of factoryFiles(input)) await writeFile(join(dir, file.path), file.content);
  if (env !== null) await writeFile(join(dir, ".factory", ".env"), env);
  return dir;
}

function filledExample(): string {
  return Object.keys(parseEnv(renderEnvExample()))
    .map((name) => `${name}=value-of-${name}`)
    .join("\n");
}

const worker = (slot: number) => ({ purpose: "worker" as const, subtask: "S1", slot });

describe("the generated .factory/config.ts", () => {
  it("should load with the image and checks it was given", async () => {
    const dir = await repoWith(INPUT, filledExample());

    const config = await loadConfig(dir);

    expect(config.image).toBe("toy-factory-worker:dev");
    expect(config.checks).toEqual(INPUT.checks);
  });

  it("should return the values of .factory/.env from environment, with its own E2E_PORT for each slot", async () => {
    const dir = await repoWith(INPUT, "FACTORY_E2E_DATABASE_URL_0=postgres://zero\nFACTORY_E2E_DATABASE_URL_1=postgres://one\n");

    const { environment } = await loadConfig(dir);

    expect(environment(worker(0))).toEqual({ E2E_PORT: "3100", E2E_DATABASE_URL: "postgres://zero" });
    expect(environment(worker(1))).toEqual({ E2E_PORT: "3101", E2E_DATABASE_URL: "postgres://one" });
  });

  it("should accept every value that .env.example lists once they are filled in", async () => {
    const dir = await repoWith(INPUT, filledExample());

    const { environment } = await loadConfig(dir);

    expect(Object.keys(environment(worker(0))).sort()).toEqual(["E2E_DATABASE_URL", "E2E_PORT"]);
    expect(Object.keys(environment(worker(1))).sort()).toEqual(["E2E_DATABASE_URL", "E2E_PORT"]);
  });

  it("should fail naming .factory/.env when the file is missing, instead of running with no values", async () => {
    const dir = await repoWith(INPUT, null);

    const { environment } = await loadConfig(dir);

    expect(() => environment(worker(0))).toThrow(".factory/.env");
  });

  it("should fail naming the variable that is missing for the slot", async () => {
    const dir = await repoWith(INPUT, "FACTORY_E2E_DATABASE_URL_0=postgres://zero\n");

    const { environment } = await loadConfig(dir);

    expect(environment(worker(0)).E2E_DATABASE_URL).toBe("postgres://zero");
    expect(() => environment(worker(1))).toThrow("FACTORY_E2E_DATABASE_URL_1");
  });

  it("should fail naming the variable when it is present but empty, as .env.example ships it", async () => {
    const dir = await repoWith(INPUT, renderEnvExample());

    const { environment } = await loadConfig(dir);

    expect(() => environment(worker(0))).toThrow("FACTORY_E2E_DATABASE_URL_0");
  });

  it("should write the default roles: Claude Code everywhere, opus for the refinement and the verifier, sonnet for the workers and the tester", async () => {
    const dir = await repoWith(INPUT, filledExample());

    expect((await loadConfig(dir)).roles).toEqual({
      workers: { agent: "claude-code", model: "sonnet" },
      verifier: { agent: "claude-code", model: "opus" },
      tester: { agent: "claude-code", model: "sonnet" },
      refinement: { agent: "claude-code", model: "opus" },
    });
  });

  it("should give the verifier a model that differs from the workers, so its independence does not rest only on a clean context", async () => {
    const dir = await repoWith(INPUT, filledExample());

    const { roles } = await loadConfig(dir);

    expect(roles.verifier?.model).not.toBe(roles.workers?.model);
  });

  it("should import nothing from the factory, so it loads when the two repos live in different folders", () => {
    const imports = renderConfig(INPUT).match(/^import .*$/gm) ?? [];

    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/from "node:/);
  });

  it("should be rejected when it loads with no checks, as a repo with no scripts must hear what is missing", async () => {
    const dir = await repoWith({ ...INPUT, checks: [] }, filledExample());

    await expect(loadConfig(dir)).rejects.toThrow("- checks must list at least one check");
  });

  it("should keep quotes and backslashes of a check command intact", async () => {
    const command = 'pnpm test -- --grep "a\\b" && echo \'done\'';
    const dir = await repoWith({ ...INPUT, checks: [{ name: "test", command }] }, filledExample());

    expect((await loadConfig(dir)).checks).toEqual([{ name: "test", command }]);
  });

  it("should keep a check name that needs escaping intact", async () => {
    const dir = await repoWith({ ...INPUT, checks: [{ name: 'test "unit"', command: "pnpm test" }] }, filledExample());

    expect((await loadConfig(dir)).checks).toEqual([{ name: 'test "unit"', command: "pnpm test" }]);
  });
});

describe("the generated .factory/Dockerfile", () => {
  it("should start from the base image of the factory", () => {
    for (const manager of ["pnpm", "npm"] as const) {
      const dockerfile = renderDockerfile(manager);
      expect(dockerfile).toMatch(/^ARG BASE_IMAGE=software-factory\/worker:dev$/m);
      expect(dockerfile).toMatch(/^FROM \$\{BASE_IMAGE\}$/m);
    }
  });

  it("should install pnpm when the lockfile names pnpm", () => {
    expect(renderDockerfile("pnpm")).toContain("npm install -g pnpm@");
  });

  it("should keep the pnpm store out of the bind-mounted worktree, because a store there leaves the worktree dirty and keeps its branch checked out", () => {
    expect(renderDockerfile("pnpm")).toMatch(/^ENV npm_config_store_dir=\/home\/agent\/\.pnpm-store$/m);
  });

  it("should not install pnpm when the lockfile names npm, because the base image already has npm", () => {
    const dockerfile = renderDockerfile("npm");

    expect(dockerfile).not.toContain("pnpm");
    expect(dockerfile).toContain("npm --version");
  });

  it("should end as the unprivileged agent user of the base image", () => {
    const lines = renderDockerfile("pnpm").trim().split("\n");

    expect(lines.filter((line) => line.startsWith("USER ")).at(-1)).toBe("USER agent");
  });
});

describe("the generated .factory/package.json", () => {
  it("should make the config load as an ES module", () => {
    expect(JSON.parse(renderPackageJson())).toEqual({ type: "module" });
  });
});

describe("the generated .dockerignore", () => {
  it("should exclude .env, because .factory/ is the build context of the worker image and .env holds secrets", () => {
    expect(dockerignoreProblem(renderDockerignore())).toBeNull();
  });
});

describe("the generated .env.example", () => {
  it("should list a variable for each slot, empty, so a copy fails closed until it is filled in", () => {
    expect(parseEnv(renderEnvExample())).toEqual({
      FACTORY_E2E_DATABASE_URL_0: "",
      FACTORY_E2E_DATABASE_URL_1: "",
    });
  });
});

describe("the slots of the generated config and .env.example", () => {
  const ceiling = Math.max(...Object.values(DEFAULT_LIMITS.agents).map((limits) => limits.maxParallelCeiling));

  it("should list a variable for every slot that the parallelism ceiling of the default limits can reach, so a run never meets a slot with no value", async () => {
    const dir = await repoWith(INPUT, filledExample());

    const { environment } = await loadConfig(dir);

    expect(Object.keys(parseEnv(renderEnvExample()))).toHaveLength(ceiling);
    for (let slot = 0; slot < ceiling; slot++) {
      expect(environment(worker(slot)).E2E_DATABASE_URL).toBe(`value-of-FACTORY_E2E_DATABASE_URL_${slot}`);
    }
  });
});

describe("factoryFiles", () => {
  it("should list the five files of .factory/ by their path from the root of the target repo", () => {
    expect(factoryFiles(INPUT).map((file) => file.path)).toEqual([
      ".factory/config.ts",
      ".factory/Dockerfile",
      ".factory/.dockerignore",
      ".factory/.env.example",
      ".factory/package.json",
    ]);
  });
});
