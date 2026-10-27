import type { ResolvedConfig, Role, RoleChoice } from "../config/config.ts";
import { loadConfig } from "../config/load.ts";
import { chooseRole, choiceProblems, credentialProblem, ROLES } from "../config/roles.ts";
import { defaultBranch, integrationBranch, showFile } from "../git/repo.ts";
import { issueCriteria } from "../spec/issue.ts";
import { parseSpec, validateSpec } from "../spec/spec.ts";
import { approvalProblem } from "./decisions.ts";
import { evidenceProblems } from "./evidence.ts";
import type { RunPorts } from "./ports.ts";
import type { Prepared, RunRequest } from "./run-context.ts";
import { schedule } from "./schedule.ts";

export async function prepare(request: RunRequest, ports: RunPorts): Promise<Prepared> {
  const branch = await integrationBranch(request.repoDir, request.issue);
  const specPath = `specs/${request.issue}.md`;
  const specText = await showFile(request.repoDir, branch, specPath);
  if (specText === null) throw new Error(`${specPath} does not exist on ${branch}`);
  const issue = await ports.github.readIssue(request.issue);
  const problem = approvalProblem(request.issue, specText, issue.body);
  if (problem !== null) throw new Error(problem);
  const base = await defaultBranch(request.repoDir);

  const config = await loadConfig(request.repoDir);
  const parsed = parseSpec(specText);
  if (!parsed.ok) throw new Error(`${specPath} is invalid: ${parsed.problems.join("; ")}`);
  const problems = validateSpec(parsed.spec, {
    issueCriteria: issueCriteria(issue.body) ?? [],
    protectedPaths: config.protectedPaths,
  });
  if (problems.length > 0) throw new Error(`${specPath} is invalid: ${problems.join("; ")}`);
  const missingEvidence = evidenceProblems(parsed.spec, config.evidence);
  if (missingEvidence.length > 0) throw new Error(`${specPath} cannot be verified: ${missingEvidence.join("; ")}`);
  const humanCriteria = Object.entries(parsed.spec.criteria)
    .filter(([, evidence]) => evidence.evidence === "human")
    .map(([id]) => id);
  const plan = schedule(parsed.spec);

  const asksVerifier = Object.values(parsed.spec.criteria).some((criterion) => criterion.evidence === "playwright");
  const testsApp = Object.values(parsed.spec.criteria).some((criterion) => criterion.evidence !== "human");
  const { workers, verifier, tester } = chosenRoles(request, config, { workers: true, verifier: asksVerifier, tester: testsApp });
  const credential = request.credentials[workers.agent] as string;
  const limits = config.agents[workers.agent];
  const parallelism = { start: limits.maxParallel, ceiling: limits.maxParallelCeiling };
  return { config, issue, branch, defaultBranch: base, spec: parsed.spec, plan, parallelism, humanCriteria, workers, verifier, tester, credential };
}

function chosenRoles(
  request: RunRequest,
  config: ResolvedConfig,
  needsCredential: Record<Role, boolean>,
): Record<Role, RoleChoice> {
  const problems: string[] = [];
  const roles: Partial<Record<Role, RoleChoice>> = {};
  for (const role of ROLES) {
    const chosen = chooseRole({ role, ...optional("flag", request.roles?.[role]), ...optional("fallback", config.roles[role]) });
    if (!chosen.ok) {
      problems.push(chosen.problem);
      continue;
    }
    const invalid = choiceProblems(role, chosen.choice);
    const missing = needsCredential[role] ? credentialProblem(role, chosen.choice, request.credentials) : null;
    problems.push(...invalid, ...(invalid.length === 0 && missing !== null ? [missing] : []));
    roles[role] = chosen.choice;
  }
  if (problems.length > 0) throw new Error(problems.join("; "));
  return roles as Record<Role, RoleChoice>;
}

function optional<K extends string, T>(key: K, value: T | undefined): Partial<Record<K, T>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, T>);
}
