import { criteriaText } from "../spec/issue.ts";
import type { Subtask } from "../spec/spec.ts";
import { revParse } from "../workers/git.ts";
import { checksOn } from "./check-container.ts";
import { verificationPassed } from "./decisions.ts";
import { integrationPlan } from "./evidence.ts";
import { followUpFailure, followUpStop, followUpTasks, verificationSignature } from "./follow-up.ts";
import { paused, stopLimits, type RunContext } from "./run-context.ts";
import { agentRunTokens } from "./run-totals.ts";
import { blockSubtask, entryOf } from "./subtask-settlement.ts";
import { workOn } from "./subtask-work.ts";

export async function verifyIntegration(context: RunContext, subtasks: Subtask[]): Promise<void> {
  const { repoDir } = context.request;
  const { branch, spec, config, issue, workers } = context.prepared;
  const { log } = context;
  const stateOf = (subtaskId: string) => entryOf(context.records, subtaskId, "record").state;
  const signatures: string[] = [];
  for (let round = 1; ; round += 1) {
    const sha = await revParse(repoDir, branch);
    const verified = await checksOn(context, {
      label: round === 1 ? "verification" : `verification-${round}`,
      sha,
      purpose: { purpose: "verification", subtask: null, slot: 0 },
      plan: integrationPlan(spec, config.evidence),
      subtaskId: null,
    });
    if (verified === null) {
      delete log.verification;
      break;
    }
    const { checks, criteria, human, appProblem } = verified;
    if (appProblem !== undefined) {
      log.verification = { sha, passed: false, checks, criteria, humanCriteria: human, environment: appProblem };
      break;
    }
    const passed = verificationPassed(checks, criteria);
    log.verification = { sha, passed, checks, criteria, humanCriteria: human };
    if (passed || context.conflicted) break;
    const tasks = followUpTasks(subtasks, criteria, stateOf);
    if (tasks.length === 0) break;
    signatures.push(verificationSignature(criteria));
    const stop = followUpStop(
      {
        signatures,
        runElapsedMs: context.ports.clock.now().getTime() - context.startedAt.getTime(),
        runTokens: agentRunTokens(log, workers.agent),
      },
      stopLimits(config, workers),
    );
    if (stop) {
      for (const task of tasks) blockSubtask(entryOf(context.records, task.subtask.id, "record"), { type: stop.type, reason: stop.reason });
      await context.save();
      break;
    }
    const texts = criteriaText(issue.body);
    let merged = false;
    for (const task of tasks) {
      const outcome = await workOn(context, task.subtask, 0, {
        round,
        criteria: task.criteria,
        text: followUpFailure(sha, task, { checks, criteria }, texts),
      });
      if (outcome === "merged") merged = true;
      if (paused(context) || context.conflicted) break;
    }
    if (!merged || paused(context) || context.conflicted) break;
  }
  if (log.verification && log.verification.sha !== (await revParse(repoDir, branch))) delete log.verification;
}
