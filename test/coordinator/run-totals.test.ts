import { describe, expect, it } from "vitest";
import {
  parseRunLog,
  RUN_LOG_VERSION,
  type AttemptRecord,
  type RunLog,
  type SubtaskRecord,
} from "../../src/coordinator/run-log.ts";
import { agentRunTokens, applyTotals, emptyCost, emptyFriction } from "../../src/coordinator/run-totals.ts";
import { emptyUsage } from "../../src/workers/agent-adapter.ts";

function attempt(agent: "claude-code" | "opencode", inputTokens: number, outputTokens: number): AttemptRecord {
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

function subtask(id: string, overrides: Partial<SubtaskRecord> = {}): SubtaskRecord {
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

function log(subtasks: SubtaskRecord[], overrides: Partial<RunLog> = {}): RunLog {
  return {
    version: RUN_LOG_VERSION,
    runId: "1-run",
    issue: 1,
    integrationBranch: "factory/1-x",
    startedAt: "2026-10-24T08:00:00.000Z",
    result: "running",
    agents: { workers: { agent: "claude-code", model: "m" }, changes: [] },
    criteria: { passing: [], blocked: [], human: [], pending: [] },
    cost: emptyCost(),
    friction: emptyFriction(),
    workerLayerFailures: [],
    subtasks,
    ...overrides,
  };
}

describe("the totals of a run record", () => {
  it("should add the tokens of every subtask up to the run total, per agent as well", () => {
    const record = log([
      subtask("S1", { attempts: [attempt("claude-code", 100, 10), attempt("claude-code", 50, 5)] }),
      subtask("S2", { attempts: [attempt("opencode", 7, 3)] }),
    ]);

    applyTotals(record, new Date("2026-10-24T08:10:00.000Z"));

    expect(record.subtasks.map((entry) => entry.usage.inputTokens)).toEqual([150, 7]);
    expect(record.cost.usage).toEqual({ ...emptyUsage(), inputTokens: 157, outputTokens: 18 });
    expect(record.cost.perAgent).toEqual({
      "claude-code": { ...emptyUsage(), inputTokens: 150, outputTokens: 15 },
      opencode: { ...emptyUsage(), inputTokens: 7, outputTokens: 3 },
    });
    expect(record.cost.attempts).toBe(3);
  });

  it("should add the usage of the verifier to the run total and to the cost of its agent, and leave the subtask total to the attempts", () => {
    const record = log([
      subtask("S1", {
        attempts: [attempt("claude-code", 100, 10)],
        verifierUsage: { opencode: { ...emptyUsage(), inputTokens: 40, outputTokens: 4 }, "claude-code": { ...emptyUsage(), inputTokens: 1 } },
      }),
      subtask("S2", { verifierUsage: { opencode: { ...emptyUsage(), inputTokens: 2, cacheReadInputTokens: 9 } } }),
    ]);

    applyTotals(record, new Date("2026-10-24T08:10:00.000Z"));

    expect(record.subtasks[0]?.usage).toEqual({ ...emptyUsage(), inputTokens: 100, outputTokens: 10 });
    expect(record.cost.usage).toEqual({ inputTokens: 143, cacheCreationInputTokens: 0, cacheReadInputTokens: 9, outputTokens: 14 });
    expect(record.cost.perAgent).toEqual({
      "claude-code": { ...emptyUsage(), inputTokens: 101, outputTokens: 10 },
      opencode: { inputTokens: 42, cacheCreationInputTokens: 0, cacheReadInputTokens: 9, outputTokens: 4 },
    });
    expect(record.cost.attempts).toBe(1);
  });

  it("should leave the time of a pause out of the wall clock", () => {
    const record = log([subtask("S1")], { endedAt: "2026-10-24T09:00:00.000Z", cost: { ...emptyCost(), pausedMs: 1_200_000 } });

    applyTotals(record, new Date("2026-10-24T12:00:00.000Z"));

    expect(record.cost.wallClockMs).toBe(2_400_000);
  });

  it("should add the friction of every subtask, with the scope extensions counted by path", () => {
    const record = log([
      subtask("S1", { scopeExtensions: ["src/a.ts", "src/b.ts"], verifierRejections: 1, gateRejections: 2 }),
      subtask("S2", { state: "blocked", blockType: "scope", conflicts: 1 }),
      subtask("S3", { state: "blocked", blockType: "scope" }),
    ]);

    applyTotals(record, new Date("2026-10-24T08:10:00.000Z"));

    expect(record.friction).toEqual({
      blocks: { scope: 2, "design-question": 0, patience: 0, limit: 0, environment: 0 },
      scopeExtensions: 2,
      gateRejections: 2,
      verifierRejections: 1,
      integrationConflicts: 1,
    });
  });

  it("should not call a criterion passing before the integrated verification passed", () => {
    const record = log([subtask("S1", { criteria: ["A1"] })]);

    applyTotals(record, new Date("2026-10-24T08:10:00.000Z"));

    expect(record.criteria).toEqual({ passing: [], blocked: [], human: [], pending: ["A1"] });
  });
});

describe("the tokens of an agent in a run", () => {
  it("should count the attempts of the agent and its verifier answers, without cache reads, because each agent has one limit", () => {
    const record = log([
      subtask("S1", {
        attempts: [attempt("opencode", 100, 10), attempt("claude-code", 5, 5)],
        verifierUsage: { opencode: { inputTokens: 40, cacheCreationInputTokens: 3, cacheReadInputTokens: 900, outputTokens: 4 } },
      }),
    ]);

    expect(agentRunTokens(record, "opencode")).toBe(157);
    expect(agentRunTokens(record, "claude-code")).toBe(10);
  });
});

describe("reading a run record back", () => {
  it("should read a record it wrote", () => {
    const record = log([subtask("S1")]);

    expect(parseRunLog(JSON.stringify(record))).toEqual({ ok: true, log: record });
  });

  it("should refuse a record of another version, naming both", () => {
    const parsed = parseRunLog(JSON.stringify({ version: 99 }));

    expect(parsed).toEqual({ ok: false, problem: `run.json has version 99, expected ${RUN_LOG_VERSION}` });
  });

  it("should refuse a file that is not JSON", () => {
    const parsed = parseRunLog("{ half a file");

    expect(parsed.ok).toBe(false);
  });
});
