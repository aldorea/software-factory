import { describe, expect, it } from "vitest";
import { ALL_ROLES_NEED_CREDENTIAL, credentialNeeds, onlyNeeded } from "../../src/coordinator/credential-needs.ts";
import type { Spec } from "../../src/spec/spec.ts";

function specWith(criteria: Spec["criteria"]): Spec {
  return { files: {}, base: null, subtasks: [], criteria };
}

describe("credentialNeeds", () => {
  it("should need only the credential of the workers when every criterion is for a human, since no tester and no verifier will run", () => {
    const spec = specWith({ A1: { evidence: "human", level: "integration", reason: "subjective" } });

    expect(credentialNeeds(spec)).toEqual({ workers: true, verifier: false, tester: false });
  });

  it("should need the credential of the tester, and not the verifier, when a criterion has request evidence", () => {
    const spec = specWith({ A1: { evidence: "request", level: "subtask" }, A2: { evidence: "human", level: "integration" } });

    expect(credentialNeeds(spec)).toEqual({ workers: true, verifier: false, tester: true });
  });

  it("should need the credential of the verifier and the tester when a criterion has playwright evidence", () => {
    const spec = specWith({ A1: { evidence: "playwright", level: "subtask" } });

    expect(credentialNeeds(spec)).toEqual({ workers: true, verifier: true, tester: true });
  });
});

describe("onlyNeeded", () => {
  const roles = { workers: "w", verifier: "v", tester: "t" };

  it("should keep the roles that need a credential and drop the others", () => {
    expect(onlyNeeded(roles, { workers: true, verifier: false, tester: true })).toEqual({ workers: "w", tester: "t" });
  });

  it("should keep every role when all of them need a credential, as when the spec is unknown", () => {
    expect(onlyNeeded(roles, ALL_ROLES_NEED_CREDENTIAL)).toEqual(roles);
  });
});
