import { RUN_LOG_VERSION, type AttemptRecord, type RunLog, type SubtaskRecord } from "../../src/coordinator/run-log.ts";
import { applyTotals, emptyCost, emptyFriction } from "../../src/coordinator/run-totals.ts";
import { emptyUsage } from "../../src/workers/agent-adapter.ts";
import type { AgentKind } from "../../src/workers/types.ts";

export function attemptRecord(agent: AgentKind, inputTokens: number, outputTokens: number): AttemptRecord {
  return {
    number: 1,
    agent: { agent, model: "m" },
    outcome: "completed",
    usage: { ...emptyUsage(), inputTokens, outputTokens },
    logPath: "/logs/attempt.jsonl",
    startedAt: "2026-10-24T08:00:00.000Z",
    endedAt: "2026-10-24T08:01:00.000Z",
  };
}

export function subtaskRecord(id: string, overrides: Partial<SubtaskRecord> = {}): SubtaskRecord {
  return {
    id,
    criteria: [],
    branch: `factory-subtask/1-x/${id}`,
    state: "merged",
    attempts: [],
    usage: emptyUsage(),
    gateRejections: 0,
    verifierRejections: 0,
    conflicts: 0,
    scopeExtensions: [],
    ...overrides,
  };
}

export interface RunFixture extends Partial<RunLog> {
  agent?: AgentKind;
  durationMs?: number;
}

export function runRecord(index: number, subtasks: SubtaskRecord[], options: RunFixture = {}): RunLog {
  const { agent = "claude-code", durationMs = 60_000, ...overrides } = options;
  const startedAt = new Date(Date.UTC(2026, 9, 1 + index, 8, 0, 0));
  const record: RunLog = {
    version: RUN_LOG_VERSION,
    runId: `1-run-${String(index).padStart(2, "0")}`,
    issue: 1,
    integrationBranch: "factory/1-x",
    startedAt: startedAt.toISOString(),
    endedAt: new Date(startedAt.getTime() + durationMs).toISOString(),
    result: "ready",
    agents: { workers: { agent, model: "m" }, changes: [] },
    criteria: { passing: [], blocked: [], human: [], pending: [] },
    cost: emptyCost(),
    friction: emptyFriction(),
    workerLayerFailures: [],
    subtasks,
    ...overrides,
  };
  applyTotals(record, new Date(record.endedAt ?? record.startedAt));
  return record;
}

export function cleanRun(index: number, agent: AgentKind = "claude-code"): RunLog {
  return runRecord(index, [subtaskRecord("S1", { attempts: [attemptRecord(agent, 100, 50)] })], { agent });
}

export function failedRun(index: number, agent: AgentKind = "claude-code"): RunLog {
  return runRecord(index, [subtaskRecord("S1", { attempts: [attemptRecord(agent, 100, 50)] })], {
    agent,
    workerLayerFailures: [
      { kind: "container-start", stage: "start", subtask: "S1", message: "docker failed", at: "2026-10-24T08:00:30.000Z" },
    ],
  });
}

export function pausedRun(index: number, limited: AgentKind = "claude-code", agent: AgentKind = "claude-code"): RunLog {
  return runRecord(index, [subtaskRecord("S1", { state: "pending" })], {
    agent,
    result: "paused",
    pauseReason: `the plan limit of ${limited} was reached`,
    pauses: [{ agent: limited, at: "2026-10-24T08:00:30.000Z" }],
  });
}
