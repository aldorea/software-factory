export const WEB_ACTION_COMMANDS = ["run", "approve", "validate", "publish", "doctor", "image", "init", "auth", "refine"] as const;

export type WebActionCommand = (typeof WEB_ACTION_COMMANDS)[number];

export interface WebActionRecord {
  version: 1;
  id: string;
  command: string;
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
