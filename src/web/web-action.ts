import { clockMinutes } from "../cli/clock-time.ts";

export const WEB_ACTION_COMMANDS = ["run", "approve", "validate", "publish", "doctor", "image", "init", "auth", "refine"] as const;

export type WebActionCommand = (typeof WEB_ACTION_COMMANDS)[number];

export const NOTHING_TO_STOP = "the web action is not working: there is nothing to stop";

export function isWebActionCommand(value: unknown): value is WebActionCommand {
  return typeof value === "string" && (WEB_ACTION_COMMANDS as readonly string[]).includes(value);
}

export function webActionStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export interface WebActionRecord {
  version: 1;
  id: string;
  command: WebActionCommand;
  args: string[];
  issue: number | null;
  startedAt: string;
  pid: number;
  processStart: string | null;
}

export interface WebActionEnd {
  exitCode: number;
  endedAt: string;
}

export interface ProcessFacts {
  startTime: string | null;
}

export type WebActionState =
  | { kind: "running"; elapsedMs: number }
  | { kind: "ended"; exitCode: number; endedAt: string }
  | { kind: "interrupted" };

export function webActionState(record: WebActionRecord, end: WebActionEnd | null, process: ProcessFacts, now: Date): WebActionState {
  if (end !== null) return { kind: "ended", exitCode: end.exitCode, endedAt: end.endedAt };
  if (record.processStart === null || process.startTime !== record.processStart) return { kind: "interrupted" };
  return { kind: "running", elapsedMs: Math.max(0, now.getTime() - Date.parse(record.startedAt)) };
}

export interface WebActionNow {
  record: Pick<WebActionRecord, "id" | "command" | "issue" | "startedAt">;
  state: WebActionState;
}

export function refineTurnInProgress(actions: readonly WebActionNow[], issue: number, ownId: string | null): string | null {
  const turn = actions.find(
    ({ record, state }) => record.command === "refine" && record.issue === issue && record.id !== ownId && state.kind === "running",
  );
  if (turn === undefined) return null;
  return `a turn of the refinement of #${issue} is in progress since ${clockMinutes(new Date(turn.record.startedAt))} (${turn.record.id}); wait for it to end or stop it`;
}
