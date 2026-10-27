import { criteriaText } from "../spec/issue.ts";
import type { Subtask } from "../spec/spec.ts";
import { revParse } from "../workers/git.ts";
import { checksOn } from "./check-container.ts";
import { verificationPassed } from "./decisions.ts";
import { integrationPlan } from "./evidence.ts";
import { acceptanceTest, evidenceTails } from "./acceptance-tester.ts";
import {
  followUpFailure,
  followUpStop,
  followUpTasks,
  integrationCheckBlock,
  verificationFailures,
  verificationSignature,
} from "./follow-up.ts";
import { paused, stopLimits, type RunContext } from "./run-context.ts";
import { agentRunTokens } from "./run-totals.ts";
import { blockSubtask, entryOf } from "./subtask-settlement.ts";
import type { TesterRecord, VerificationRecord } from "./run-log.ts";
import { pauseRun, workOn } from "./subtask-work.ts";

export async function verifyIntegration(context: RunContext, subtasks: Subtask[]): Promise<void> {
  const { repoDir } = context.request;
  const { branch, spec, config, issue, workers } = context.prepared;
  const { log } = context;
  const stateOf = (subtaskId: string) => entryOf(context.records, subtaskId, "record").state;
  const signatures: string[] = [];
  delete log.block;
  for (let round = 1; ; round += 1) {
    const sha = await revParse(repoDir, branch);
    context.verifications += 1;
    const label = context.verifications === 1 ? "verification" : `verification-${context.verifications}`;
    const verified = await checksOn(context, {
      label,
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
    const verification: VerificationRecord = { sha, passed, checks, criteria, humanCriteria: human };
    log.verification = verification;
    if (context.conflicted) break;
    let tester: TesterRecord | undefined;
    if (passed) {
      if (criteria.length === 0) break;
      const tested = await acceptanceTest(context, { label, sha, criteria });
      if (tested.kind === "plan-limit") {
        verification.passed = false;
        pauseRun(context, tested);
        await context.save();
        break;
      }
      tester = tested.record;
      verification.tester = tester;
      verification.passed = tester.error === undefined && tester.verdicts.every((verdict) => verdict.passed);
      await context.save();
      if (verification.passed || tester.error !== undefined) break;
    }
    const failures = verificationFailures(criteria, tester);
    const tasks = followUpTasks(subtasks, failures, stateOf);
    if (tasks.length === 0) {
      const block = integrationCheckBlock(sha, checks, criteria);
      if (block !== null) log.block = block;
      break;
    }
    signatures.push(verificationSignature(failures));
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
    const tails = tester === undefined ? {} : await evidenceTails(context.runDir, tester);
    let merged = false;
    for (const task of tasks) {
      const outcome = await workOn(context, task.subtask, 0, {
        round,
        criteria: task.criteria,
        text: followUpFailure(sha, task, { checks, criteria, ...(tester ? { tester } : {}) }, texts, tails),
      });
      if (outcome === "merged") merged = true;
      if (paused(context) || context.conflicted) break;
    }
    if (!merged || paused(context) || context.conflicted) break;
  }
  if (log.verification && log.verification.sha !== (await revParse(repoDir, branch))) delete log.verification;
}
