import { describe, expect, it } from "vitest";
import { chooseRole, credentialProblem, choiceProblems, parseRoleFlag } from "../../src/config/roles.ts";

const SONNET = { agent: "claude-code", model: "sonnet" } as const;
const OPUS = { agent: "claude-code", model: "opus" } as const;
const KIMI = { agent: "opencode", model: "opencode-go/kimi-k2" } as const;

describe("the choice of the agent of a role", () => {
  it("should take the flag over the prompt and the default", () => {
    expect(chooseRole({ role: "workers", flag: OPUS, prompted: SONNET, fallback: SONNET })).toEqual({ ok: true, choice: OPUS });
  });

  it("should take the prompt over the default when no flag gives one", () => {
    expect(chooseRole({ role: "workers", prompted: OPUS, fallback: SONNET })).toEqual({ ok: true, choice: OPUS });
  });

  it("should take the default when there is neither flag nor prompt, as outside a terminal", () => {
    expect(chooseRole({ role: "verifier", fallback: KIMI })).toEqual({ ok: true, choice: KIMI });
  });

  it("should refuse with none of them, naming the flag and the config setting", () => {
    const chosen = chooseRole({ role: "verifier" });

    expect(chosen.ok).toBe(false);
    expect(chosen.ok ? "" : chosen.problem).toContain("--verifier-agent");
    expect(chosen.ok ? "" : chosen.problem).toContain("roles.verifier");
  });
});

describe("the flag of a role", () => {
  it("should read the agent and the model, keeping the slash of an opencode-go model", () => {
    expect(parseRoleFlag("verifier", "opencode:opencode-go/kimi-k2")).toEqual({ ok: true, choice: KIMI });
  });

  it("should take the model of the default when the flag names only the default's agent", () => {
    expect(parseRoleFlag("workers", "claude-code", SONNET)).toEqual({ ok: true, choice: SONNET });
  });

  it("should refuse an agent alone that the default does not use, because the model would be a guess", () => {
    const parsed = parseRoleFlag("workers", "claude-code", undefined);

    expect(parsed.ok ? "" : parsed.problem).toContain("--worker-agent claude-code:<model>");
  });

  it("should refuse an unknown agent", () => {
    const parsed = parseRoleFlag("workers", "codex:gpt");

    expect(parsed.ok ? "" : parsed.problem).toContain("codex is not an agent: use one of claude-code, opencode");
  });
});

describe("the requirements of a role", () => {
  it("should accept any agent in any role, since every agent meets every requirement", () => {
    expect(choiceProblems("workers", KIMI)).toEqual([]);
    expect(choiceProblems("verifier", SONNET)).toEqual([]);
    expect(choiceProblems("tester", KIMI)).toEqual([]);
  });

  it("should refuse an OpenCode model outside opencode-go/, because the other providers are pay per use", () => {
    expect(choiceProblems("verifier", { agent: "opencode", model: "opencode/kimi-k2" })).toEqual([
      "the verifier model must be an opencode-go/ model: other OpenCode providers are pay per use",
    ]);
  });

  it("should accept the workers and the verifier on the same agent and model when the agent meets both roles", () => {
    expect(choiceProblems("workers", SONNET)).toEqual([]);
    expect(choiceProblems("verifier", KIMI)).toEqual([]);
  });

  it("should say in the same line how to get the credential and that factory auth saves it", () => {
    const problem = credentialProblem("verifier", KIMI, {});
    expect(problem).not.toContain("\n");
    expect(problem).toContain("factory auth opencode");
    expect(problem).toContain("Extra Usage");
  });

  it("should name the variable of a missing credential", () => {
    expect(credentialProblem("verifier", KIMI, { "claude-code": "token" })).toContain(
      "OPENCODE_API_KEY is not set; the opencode verifier needs it",
    );
    expect(credentialProblem("workers", SONNET, { "claude-code": "token" })).toBeNull();
  });
});
