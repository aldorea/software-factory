import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeRunLog, type RunLog } from "../../src/coordinator/run-log.ts";
import { emptyUsage } from "../../src/workers/agent-adapter.ts";
import { runRecord, subtaskRecord } from "./run-log-fixtures.ts";

export interface RunningRunInput {
  logsDir: string;
  issue?: number;
  runJsonAt: Date;
  logAt: Date;
  attemptIdleTimeoutMs?: number;
}

export interface RunningRun {
  runId: string;
  runDir: string;
  logPath: string;
  log: RunLog;
}

export async function writeRunningRun({ logsDir, issue = 7, runJsonAt, logAt, attemptIdleTimeoutMs }: RunningRunInput): Promise<RunningRun> {
  const runId = `${issue}-${runJsonAt.toISOString().replace(/[:.]/g, "-")}`;
  const runDir = join(logsDir, runId);
  const logPath = join(runDir, "S1-attempt-1.jsonl");
  const { endedAt: _endedAt, ...base } = runRecord(0, [], { issue, runId, result: "running" });
  const log: RunLog = {
    ...base,
    startedAt: runJsonAt.toISOString(),
    ...(attemptIdleTimeoutMs !== undefined ? { attemptIdleTimeoutMs } : {}),
    subtasks: [
      subtaskRecord("S1", {
        state: "working",
        attempts: [
          {
            number: 1,
            agent: { agent: "claude-code", model: "m" },
            outcome: "running",
            usage: emptyUsage(),
            logPath,
            startedAt: runJsonAt.toISOString(),
          },
        ],
      }),
    ],
  };
  await mkdir(runDir, { recursive: true });
  await writeFile(logPath, '{"type":"assistant"}\n');
  await utimes(logPath, logAt, logAt);
  await writeRunLog(join(runDir, "run.json"), log);
  await utimes(join(runDir, "run.json"), runJsonAt, runJsonAt);
  return { runId, runDir, logPath, log };
}
