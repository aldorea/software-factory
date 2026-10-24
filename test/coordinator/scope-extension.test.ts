import { describe, expect, it } from "vitest";
import { decideScopeExtension, type ScopeExtensionInput } from "../../src/coordinator/scope-extension.ts";

function input(overrides: Partial<ScopeExtensionInput> = {}): ScopeExtensionInput {
  return {
    requested: ["docs/notes.md"],
    scope: ["src/"],
    waveScopes: [],
    protectedPaths: ["package.json", ".factory"],
    ...overrides,
  };
}

describe("decideScopeExtension", () => {
  it("should extend the scope with a free file that no protected path covers", () => {
    expect(decideScopeExtension(input())).toEqual({ kind: "extend", paths: ["docs/notes.md"] });
  });

  it("should block a file that a subtask of the same wave owns, naming that subtask", () => {
    const decision = decideScopeExtension(input({ waveScopes: [{ subtask: "S2", scope: ["docs/"] }] }));

    expect(decision).toEqual({
      kind: "block",
      reason: "It needs docs/notes.md, which S2 of the same wave owns.",
    });
  });

  it("should block a directory that holds the scope of a subtask of the same wave, because the two would overlap", () => {
    const decision = decideScopeExtension(
      input({ requested: ["docs"], waveScopes: [{ subtask: "S2", scope: ["docs/api/openapi.yaml"] }] }),
    );

    expect(decision).toMatchObject({ kind: "block", reason: expect.stringContaining("S2") });
  });

  it("should block a protected path", () => {
    const decision = decideScopeExtension(input({ requested: ["package.json"] }));

    expect(decision).toEqual({ kind: "block", reason: "It needs package.json, which is a protected path." });
  });

  it("should block a file inside a protected folder", () => {
    const decision = decideScopeExtension(input({ requested: [".factory/config.ts"] }));

    expect(decision).toEqual({ kind: "block", reason: "It needs .factory/config.ts, which is a protected path." });
  });

  it("should block the whole request when any file of it is refused, and name every refusal", () => {
    const decision = decideScopeExtension(
      input({ requested: ["docs/notes.md", "package.json", "lib/a.ts"], waveScopes: [{ subtask: "S2", scope: ["lib/"] }] }),
    );

    expect(decision).toEqual({
      kind: "block",
      reason: "It needs package.json, which is a protected path. It needs lib/a.ts, which S2 of the same wave owns.",
    });
  });

  it("should block a path that leaves the repository, because it is not a file of the target repo", () => {
    expect(decideScopeExtension(input({ requested: ["../secrets.env"] }))).toEqual({
      kind: "block",
      reason: "It needs ../secrets.env, which is not a path inside the repository.",
    });
    expect(decideScopeExtension(input({ requested: ["/etc/hosts"] }))).toMatchObject({ kind: "block" });
    expect(decideScopeExtension(input({ requested: ["."] }))).toMatchObject({ kind: "block" });
  });

  it("should leave out a file that the scope already covers and report it as covered when nothing else is left", () => {
    expect(decideScopeExtension(input({ requested: ["src/a.ts", "docs/notes.md"] }))).toEqual({
      kind: "extend",
      paths: ["docs/notes.md"],
    });
    expect(decideScopeExtension(input({ requested: ["src/a.ts"] }))).toEqual({ kind: "covered", paths: ["src/a.ts"] });
  });

  it("should write each path in its normal form so that ./docs//notes.md is docs/notes.md", () => {
    expect(decideScopeExtension(input({ requested: ["./docs//notes.md"] }))).toEqual({
      kind: "extend",
      paths: ["docs/notes.md"],
    });
  });

  it("should not add the same path twice", () => {
    expect(decideScopeExtension(input({ requested: ["docs/notes.md", "docs/notes.md"] }))).toEqual({
      kind: "extend",
      paths: ["docs/notes.md"],
    });
  });
});
