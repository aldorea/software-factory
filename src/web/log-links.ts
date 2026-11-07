import { extname } from "node:path";
import type { RunLog } from "../coordinator/run-log.ts";
import { runLogSegments, runLogUrl, type LogUrl } from "./log-path.ts";
import { resolveFileInside } from "./file-inside.ts";

const RAW_LOG_EXTENSION = ".jsonl";

function outputLogsOf(log: RunLog): Array<string | undefined> {
  const verification = log.verification;
  const progress = log.verificationProgress;
  const outputs = [
    ...(log.block?.type === "integration-check" ? log.block.checks : []),
    ...log.subtasks.flatMap((subtask) => (subtask.gate === undefined ? [] : [...subtask.gate.checks, ...subtask.gate.criteria])),
    ...(progress === undefined ? [] : [...progress.checks, ...progress.criteria]),
    ...(verification === undefined ? [] : [...verification.checks, ...verification.criteria, ...(verification.tester?.checks ?? [])]),
  ];
  return outputs.map((output) => output.outputLog);
}

function evidenceFilesOf(log: RunLog): string[] {
  const verification = log.verification;
  if (verification === undefined) return [];
  return [
    ...verification.criteria.flatMap((criterion) => criterion.evidenceFiles ?? []),
    ...(verification.tester?.verdicts ?? []).flatMap((verdict) => verdict.evidence),
    ...verification.humanCriteria.flatMap((criterion) => criterion.attachments),
  ];
}

function linkable(path: unknown): path is string {
  return typeof path === "string" && extname(path).toLowerCase() !== RAW_LOG_EXTENSION;
}

export async function logLinks(runId: string, runDir: string, log: RunLog): Promise<LogUrl> {
  const urls = new Map<string, string>();
  for (const path of new Set([...outputLogsOf(log), ...evidenceFilesOf(log)])) {
    if (!linkable(path)) continue;
    const segments = runLogSegments(runDir, path);
    if (segments !== null && (await resolveFileInside(runDir, segments)) !== null) urls.set(path, runLogUrl(runId, segments));
  }
  return (path) => (path === undefined ? null : (urls.get(path) ?? null));
}
