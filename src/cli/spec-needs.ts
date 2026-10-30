import { ALL_ROLES_NEED_CREDENTIAL, credentialNeeds, type CredentialNeeds } from "../coordinator/credential-needs.ts";
import { findIntegrationBranch, showFile } from "../git/repo.ts";
import { parseSpec } from "../spec/spec.ts";

async function specText(repoDir: string, issue: number): Promise<string | null> {
  try {
    const branch = await findIntegrationBranch(repoDir, issue);
    return branch === null ? null : await showFile(repoDir, branch, `specs/${issue}.md`);
  } catch {
    return null;
  }
}

export async function specCredentialNeeds(repoDir: string, issue: number): Promise<CredentialNeeds> {
  const text = await specText(repoDir, issue);
  if (text === null) return ALL_ROLES_NEED_CREDENTIAL;
  const parsed = parseSpec(text);
  return parsed.ok ? credentialNeeds(parsed.spec) : ALL_ROLES_NEED_CREDENTIAL;
}
