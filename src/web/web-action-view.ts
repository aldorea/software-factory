import { commandText } from "./action-args.ts";
import type { WebActionFiles } from "./web-action-files.ts";
import { webActionState, type ProcessFacts, type WebActionState } from "./web-action.ts";

export interface WebActionView {
  id: string;
  name: string;
  command: string;
  issue: number | null;
  startedAt: string;
  state: WebActionState;
  canStop: boolean;
  output: string | null;
  inProgress: boolean;
}

export function webActionView({ record, end }: WebActionFiles, process: ProcessFacts, output: string | null, now: Date): WebActionView {
  const state = webActionState(record, end, process, now);
  return {
    id: record.id,
    name: record.command,
    command: commandText(record.args),
    issue: record.issue,
    startedAt: record.startedAt,
    state,
    canStop: state.kind === "running",
    output,
    inProgress: state.kind === "running",
  };
}
