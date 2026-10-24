import { describe, expect, it } from "vitest";
import { renderPullRequest } from "../../src/coordinator/pull-request.ts";
import { RUN_LOG_VERSION, type AttemptRecord, type RunLog } from "../../src/coordinator/run-log.ts";
import { emptyCost, emptyFriction } from "../../src/coordinator/run-totals.ts";
import { agentTokens } from "../../src/coordinator/stop-rules.ts";
import { emptyUsage } from "../../src/workers/agent-adapter.ts";

const ISSUE = { number: 1, title: "Greeting", body: "" };

function log(agents: RunLog["agents"]): RunLog {
  return {
    version: RUN_LOG_VERSION,
    runId: "1-run",
    issue: 1,
    integrationBranch: "factory/1-x",
    startedAt: "2026-10-24T08:00:00.000Z",
    result: "ready",
    agents,
    criteria: { passing: [], blocked: [], human: [], pending: [] },
    cost: emptyCost(),
    friction: emptyFriction(),
    workerLayerFailures: [],
    subtasks: [],
  };
}

function attempt(agent: "claude-code" | "opencode", outputTokens: number): AttemptRecord {
  return {
    number: 1,
    agent: { agent, model: "m" },
    outcome: "completed",
    usage: { ...emptyUsage(), outputTokens },
    logPath: "/logs/attempt.jsonl",
    startedAt: "2026-10-24T08:00:00.000Z",
    endedAt: "2026-10-24T08:01:00.000Z",
  };
}

describe("the agents in the pull request", () => {
  it("should say in one line that the verifier used the same model as the workers, because its independence then rests on its clean context", () => {
    const shared = { agent: "opencode", model: "opencode-go/kimi-k2" } as const;

    const { body } = renderPullRequest(ISSUE, log({ workers: shared, verifier: shared, changes: [] }));

    expect(body).toContain("The independent verifier used the same model as the workers: its independence rests on its clean context alone.");
  });

  it("should not flag a verifier on another model of the same agent", () => {
    const { body } = renderPullRequest(
      ISSUE,
      log({
        workers: { agent: "opencode", model: "opencode-go/kimi-k2" },
        verifier: { agent: "opencode", model: "opencode-go/glm-4.6" },
        changes: [],
      }),
    );

    expect(body).not.toContain("same model as the workers");
  });
});

describe("the tokens of an agent", () => {
  it("should count only the attempts of that agent, so a change of agent on resume starts the new agent's limits from its own use", () => {
    const attempts = [attempt("claude-code", 300), attempt("opencode", 40), attempt("claude-code", 200)];

    expect(agentTokens(attempts, "claude-code")).toBe(500);
    expect(agentTokens(attempts, "opencode")).toBe(40);
  });
});
