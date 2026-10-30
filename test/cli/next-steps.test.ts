import { describe, expect, it } from "vitest";
import { renderSetup } from "../../src/cli/setup-render.ts";
import { nextSteps, type NextStepsFacts } from "../../src/cli/next-steps.ts";

const FRESH: NextStepsFacts = {
  image: "toy-factory-worker:dev",
  envVariables: ["FACTORY_E2E_DATABASE_URL_0", "FACTORY_E2E_DATABASE_URL_1"],
  envValues: null,
  agents: ["claude-code"],
  credentials: {},
  workerImagePresent: false,
};

const plain = (facts: NextStepsFacts) => renderSetup(nextSteps(facts), false);

describe("nextSteps", () => {
  it("should list the five steps of a fresh repo, naming each variable of .env.example and the worker image", () => {
    expect(plain(FRESH)).toEqual([
      "Next:",
      "  1. fill .factory/.env (copy of .env.example: FACTORY_E2E_DATABASE_URL_0, FACTORY_E2E_DATABASE_URL_1)",
      "  2. factory auth          set the credential of each agent, once for every repo",
      "  3. factory image         build the base image and toy-factory-worker:dev",
      "  4. factory doctor        check that everything is ready",
      "  5. factory refine <n>",
    ]);
  });

  it("should mark the credential step with a tick when every agent of the roles has one, so a saved credential is not asked for again", () => {
    const lines = plain({ ...FRESH, credentials: { "claude-code": "sk-ant-oat01-saved" } });

    expect(lines[2]).toBe("✓ 2. factory auth          set the credential of each agent, once for every repo");
    expect(lines.filter((line) => line.startsWith("✓"))).toHaveLength(1);
  });

  it("should leave the credential step pending when only one of two agents of the roles has a credential", () => {
    const lines = plain({ ...FRESH, agents: ["claude-code", "opencode"], credentials: { "claude-code": "x" } });

    expect(lines[2]?.startsWith("  2. ")).toBe(true);
  });

  it("should ignore a credential of an agent that no role uses", () => {
    const lines = plain({ ...FRESH, credentials: { opencode: "x" } });

    expect(lines[2]?.startsWith("  2. ")).toBe(true);
  });

  it("should mark the .env step with a tick once .factory/.env gives a value to every variable", () => {
    const lines = plain({
      ...FRESH,
      envValues: { FACTORY_E2E_DATABASE_URL_0: "postgres://a", FACTORY_E2E_DATABASE_URL_1: "postgres://b" },
    });

    expect(lines[1]?.startsWith("✓ 1. fill .factory/.env")).toBe(true);
  });

  it("should leave the .env step pending when a variable is empty or missing, as a copy of .env.example ships it", () => {
    const empty = plain({ ...FRESH, envValues: { FACTORY_E2E_DATABASE_URL_0: "x", FACTORY_E2E_DATABASE_URL_1: "" } });
    const missing = plain({ ...FRESH, envValues: { FACTORY_E2E_DATABASE_URL_0: "x" } });

    expect(empty[1]?.startsWith("  1. ")).toBe(true);
    expect(missing[1]?.startsWith("  1. ")).toBe(true);
  });

  it("should mark the image step with a tick when the worker image exists", () => {
    const lines = plain({ ...FRESH, workerImagePresent: true });

    expect(lines[3]).toBe("✓ 3. factory image         build the base image and toy-factory-worker:dev");
  });

  it("should never mark doctor and refine as done, because nothing on the host says they ran", () => {
    const lines = plain({
      ...FRESH,
      envValues: { FACTORY_E2E_DATABASE_URL_0: "a", FACTORY_E2E_DATABASE_URL_1: "b" },
      credentials: { "claude-code": "x" },
      workerImagePresent: true,
    });

    expect(lines.slice(4)).toEqual(["  4. factory doctor        check that everything is ready", "  5. factory refine <n>"]);
  });

  it("should drop the .env step and renumber when .env.example lists no variable", () => {
    expect(plain({ ...FRESH, envVariables: [] })).toEqual([
      "Next:",
      "  1. factory auth          set the credential of each agent, once for every repo",
      "  2. factory image         build the base image and toy-factory-worker:dev",
      "  3. factory doctor        check that everything is ready",
      "  4. factory refine <n>",
    ]);
  });

  it("should paint the title in bold, each pending command in cyan and the tick of a done step in green when colour is on", () => {
    const lines = renderSetup(nextSteps({ ...FRESH, credentials: { "claude-code": "x" } }), true);

    expect(lines[0]).toBe("\u001b[1mNext:\u001b[0m");
    expect(lines[2]).toBe("\u001b[1;92m✓\u001b[0m 2. factory auth          set the credential of each agent, once for every repo");
    expect(lines[3]).toBe(
      "  3. \u001b[1;96mfactory image\u001b[0m         build the base image and toy-factory-worker:dev",
    );
  });
});
