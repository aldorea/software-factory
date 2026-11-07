import { join } from "node:path";
import { readSession, turnStreamPath, writeSession } from "../commands/conversation.ts";
import { prepareRefinement } from "../commands/refine.ts";
import { startTurnProcess } from "../commands/refine-turn.ts";
import type { RoleChoice } from "../config/config.ts";
import { processStartTime } from "../web/process-start.ts";
import { readWebActions } from "../web/web-action-files.ts";
import { webActionState, type WebActionRecord } from "../web/web-action.ts";
import { adapterFor } from "../workers/agents.ts";
import { refinementTools } from "../workers/refinement-turn.ts";
import { clockMinutes } from "./clock-time.ts";
import type { CliEnv } from "./main.ts";

export function noTurnProblem(choice: RoleChoice): string | null {
  if (adapterFor(choice.agent).refinementTurn !== undefined) return null;
  return `${choice.agent} has no turn of the refinement, so it cannot refine from the web: the refinement stays on Claude Code until a real run proves its skill with ${choice.agent} (ADR 0003)`;
}

async function turnInProgress(repoDir: string, issue: number, ownId: string | null, now: Date): Promise<string | null> {
  for (const { record, end } of await readWebActions(repoDir)) {
    if (record.command !== "refine" || record.issue !== issue || record.id === ownId) continue;
    const state = webActionState(record, end, { startTime: await processStartTime(record.pid) }, now);
    if (state.kind === "running") return turnInProgressMessage(issue, record);
  }
  return null;
}

export function turnInProgressMessage(issue: number, record: Pick<WebActionRecord, "id" | "startedAt">): string {
  return `a turn of the refinement of #${issue} is in progress since ${clockMinutes(new Date(record.startedAt))} (${record.id}); wait for it to end or stop it`;
}

function turnId(ownId: string | null, now: Date): string {
  return ownId ?? now.toISOString().replace(/[:.]/g, "-");
}

export async function refineTurn(input: {
  repoDir: string;
  issue: number;
  choice: RoleChoice;
  webActionId: string | null;
  env: CliEnv;
}): Promise<string | number> {
  const { repoDir, issue, choice, env } = input;
  const turn = adapterFor(choice.agent).refinementTurn;
  if (turn === undefined) return noTurnProblem(choice) ?? "";
  const busy = await turnInProgress(repoDir, issue, input.webActionId, env.clock.now());
  if (busy !== null) return busy;
  const session = await readSession(repoDir, issue);
  const answer = (await env.readStdin?.()) ?? "";
  if (session === null && answer.trim() !== "") return `the first turn of the refinement of #${issue} starts its skill and takes no answer`;
  if (session !== null && answer.trim() === "") return `the answer is empty: the turn of the refinement of #${issue} reads it on stdin`;
  const workspace = await prepareRefinement({ repoDir, issue, github: env.github(repoDir) });
  const place = {
    issue,
    repoDir,
    worktree: workspace.worktree,
    factoryCli: join(env.factoryRoot, "src", "cli", "factory.ts"),
    pluginDir: join(env.factoryRoot, "plugins", "refinement"),
  };
  const command = turn.command({ place, session, model: choice.model, allowedTools: refinementTools(place) });
  if (!command.ok) return command.problem;
  env.out(`${session === null ? "Starting" : "Resuming"} the refinement of #${issue} in ${workspace.worktree}`);
  const end = await startTurnProcess({
    command: env.agentCommand?.(choice.agent) ?? adapterFor(choice.agent).processName,
    args: command.args,
    env: command.env,
    cwd: workspace.worktree,
    answer: command.readsAnswer ? answer : "",
    streamPath: await turnStreamPath(repoDir, issue, turnId(input.webActionId, env.clock.now())),
    checker: turn.checker(),
    onLoaded: (loaded) => writeSession(repoDir, issue, { session: loaded, agent: choice.agent }),
    onStderr: env.err,
  });
  if (end.kind === "refused") return end.problem;
  env.out(end.exitCode === 0 ? `The turn of the refinement of #${issue} ended; answer it from the web` : `The turn of the refinement of #${issue} failed`);
  return end.exitCode;
}
