import { readConversationSession, readTurns } from "../commands/conversation.ts";
import { adapterFor } from "../workers/agents.ts";
import type { TurnMessage } from "../workers/refinement-turn.ts";
import type { AgentKind } from "../workers/types.ts";
import type { WebActionView } from "./web-action-view.ts";

export interface RefinementTurnView {
  id: string;
  messages: TurnMessage[];
}

export interface RefinementConversation {
  issue: number;
  started: boolean;
  agent: AgentKind | null;
  turns: RefinementTurnView[];
  current: WebActionView | null;
  inProgress: boolean;
}

export async function refinementConversation(repoDir: string, issue: number, actions: readonly WebActionView[]): Promise<RefinementConversation> {
  const session = await readConversationSession(repoDir, issue);
  const transcript = adapterFor(session?.agent ?? "claude-code").refinementTurn?.transcript ?? (() => []);
  const turns = (await readTurns(repoDir, issue)).map((turn) => ({ id: turn.id, messages: transcript(turn.lines) }));
  const current = actions.find((action) => action.name === "refine" && action.issue === issue && action.state.kind === "running") ?? null;
  return { issue, started: session !== null, agent: session?.agent ?? null, turns, current, inProgress: current !== null };
}
