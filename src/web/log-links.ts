import type { RunLog } from "../coordinator/run-log.ts";
import { runLogSegments, runLogUrl, type LogUrl } from "./log-path.ts";
import { resolveRunFile } from "./run-file.ts";
import { logPathsOf } from "./run-log-paths.ts";

export async function logLinks(runId: string, runDir: string, log: RunLog): Promise<LogUrl> {
  const urls = new Map<string, string>();
  for (const logPath of logPathsOf(log)) {
    const segments = runLogSegments(runDir, logPath);
    if (segments !== null && (await resolveRunFile(runDir, segments)) !== null) urls.set(logPath, runLogUrl(runId, segments));
  }
  return (logPath) => (logPath === undefined ? null : (urls.get(logPath) ?? null));
}
