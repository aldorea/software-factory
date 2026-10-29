import type { CheckRecord, CriterionRecord, RunLog } from "../coordinator/run-log.ts";

type Output = CheckRecord | CriterionRecord;

export function logPathsOf(log: RunLog): string[] {
  const outputs: Output[] = [...(log.block?.type === "integration-check" ? log.block.checks : [])];
  const paths: Array<string | undefined> = [];
  for (const subtask of log.subtasks) {
    paths.push(...subtask.attempts.map((attempt) => attempt.logPath));
    if (subtask.gate === undefined) continue;
    paths.push(...subtask.gate.verifier.map((record) => record.logPath));
    outputs.push(...subtask.gate.checks, ...subtask.gate.criteria);
  }
  if (log.verification !== undefined) {
    outputs.push(...log.verification.checks, ...log.verification.criteria);
    paths.push(log.verification.tester?.logPath);
  }
  paths.push(...outputs.map((output) => output.outputLog));
  return [...new Set(paths.filter((path): path is string => typeof path === "string"))];
}
