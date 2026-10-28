import { describe, expect, it } from "vitest";
import type { RunLog } from "../../src/coordinator/run-log.ts";
import { summarizeRuns } from "../../src/coordinator/stats.ts";
import { statsView } from "../../src/web/stats-view.ts";
import { cleanRun, failedRun, pausedRun } from "../coordinator/run-log-fixtures.ts";
import { visibleText } from "./web-helpers.ts";

function viewOf(...logs: RunLog[]): string {
  return visibleText(statsView(summarizeRuns(logs)));
}

describe("the statistics of each agent", () => {
  it("should show the runs, attempts, tokens and pauses of each agent so the subscriptions can be compared", () => {
    const text = viewOf(cleanRun(0, "claude-code"), cleanRun(1, "opencode"), cleanRun(2, "opencode"), pausedRun(3, "opencode", "opencode"));

    expect(text).toContain("Agente Runs Attempts Tokens Pausas");
    expect(text).toContain("claude-code 1 1 150 0");
    expect(text).toContain("opencode 3 2 300 1");
  });
});

describe("the friction of the runs", () => {
  it("should show the blocks by type, the scope extensions, the rejections and the conflicts", () => {
    const first = cleanRun(0);
    const second = cleanRun(1);
    const friction = (blocks: Partial<Record<string, number>>, rest: Partial<RunLog["friction"]>): RunLog["friction"] => ({
      ...first.friction,
      blocks: { ...first.friction.blocks, ...blocks },
      ...rest,
    });
    const text = viewOf(
      { ...first, friction: friction({ scope: 2, patience: 1 }, { scopeExtensions: 3, gateRejections: 4 }) },
      { ...second, friction: friction({ scope: 1 }, { verifierRejections: 5, testerRejections: 6, integrationConflicts: 7 }) },
    );

    expect(text).toContain("Bloqueos scope 3, patience 1");
    expect(text).toContain("Scope extensions 3");
    expect(text).toContain("Rechazos del gate 4");
    expect(text).toContain("Rechazos del independent verifier 5");
    expect(text).toContain("Rechazos del acceptance tester 6");
    expect(text).toContain("Conflictos de integración 7");
  });

  it("should say there are no blocks when no run was blocked", () => {
    expect(viewOf(cleanRun(0))).toContain("Bloqueos ninguno");
  });
});

describe("the failures of the worker layer", () => {
  it("should count the failures by kind", () => {
    const failure = failedRun(1).workerLayerFailures[0] as RunLog["workerLayerFailures"][number];
    const text = viewOf(failedRun(0), { ...failedRun(1), workerLayerFailures: [failure, { ...failure, kind: "process-hang" }] });

    expect(text).toContain("Fallos de la worker layer container-start 2, process-hang 1");
  });

  it("should say there are no failures when the worker layer did not fail", () => {
    expect(viewOf(cleanRun(0))).toContain("Fallos de la worker layer ninguno");
  });
});

describe("the cost of the runs", () => {
  it("should show the total and the average of attempts, tokens and wall clock without pauses", () => {
    const text = viewOf(cleanRun(0), cleanRun(1), failedRun(2));

    expect(text).toContain("Tokens 450 (150 por run, 150 por subtask, como máximo 150 en un subtask)");
    expect(text).toContain("Attempts 3 (1.0 por run, 1.0 por subtask)");
    expect(text).toContain("Wall clock sin pausas 3 min (1 min por run)");
  });

  it("should show the time paused", () => {
    const run = cleanRun(0);
    const text = viewOf({ ...run, cost: { ...run.cost, pausedMs: 90 * 60_000 } });

    expect(text).toContain("Pausa 1 h 30 min");
  });
});
