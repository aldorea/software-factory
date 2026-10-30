import type { RunRole } from "../config/config.ts";
import type { Spec } from "../spec/spec.ts";

export type CredentialNeeds = Record<RunRole, boolean>;

export const ALL_ROLES_NEED_CREDENTIAL: CredentialNeeds = { workers: true, verifier: true, tester: true };

export function credentialNeeds(spec: Spec): CredentialNeeds {
  const criteria = Object.values(spec.criteria);
  return {
    workers: true,
    verifier: criteria.some((criterion) => criterion.evidence === "playwright"),
    tester: criteria.some((criterion) => criterion.evidence !== "human"),
  };
}

export function onlyNeeded<T>(roles: Partial<Record<RunRole, T>>, needs: CredentialNeeds): Partial<Record<RunRole, T>> {
  const kept: Partial<Record<RunRole, T>> = {};
  for (const role of Object.keys(roles) as RunRole[]) {
    const choice = roles[role];
    if (needs[role] && choice !== undefined) kept[role] = choice;
  }
  return kept;
}
