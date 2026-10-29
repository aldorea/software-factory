import type { ActivityEntry } from "../coordinator/ports.ts";
import type { RunLog } from "../coordinator/run-log.ts";
import { CLEAR_LINE, renderActivity, renderProgress, runningAttempts, sourceColours, statusLine, type RunningAttempt } from "./terminal-render.ts";

export interface RunViewOptions {
  now(): Date;
  write(text: string): void;
  columns(): number;
}

export class RunView {
  private readonly options: RunViewOptions;
  private attempts: RunningAttempt[] = [];
  private readonly lastActivity = new Map<string, Date>();
  private readonly colours = sourceColours();
  private drawn = false;

  constructor(options: RunViewOptions) {
    this.options = options;
  }

  progress(line: string): void {
    this.history(renderProgress(line, this.options.now(), true));
  }

  activity(entry: ActivityEntry): void {
    this.lastActivity.set(entry.source, entry.at);
    this.history(renderActivity(entry, true, this.colours));
  }

  snapshot(log: RunLog): void {
    const next = runningAttempts(log);
    for (const attempt of next) {
      const known = this.attempts.some((entry) => entry.source === attempt.source && entry.number === attempt.number);
      if (!known) this.lastActivity.delete(attempt.source);
    }
    this.attempts = next;
  }

  tick(): void {
    const status = this.status();
    if (status === "" && !this.drawn) return;
    this.options.write(`${CLEAR_LINE}${status}`);
    this.drawn = status !== "";
  }

  finish(): void {
    if (!this.drawn) return;
    this.options.write(CLEAR_LINE);
    this.drawn = false;
  }

  private history(text: string): void {
    const status = this.status();
    this.options.write(`${CLEAR_LINE}${text}\n${status}`);
    this.drawn = status !== "";
  }

  private status(): string {
    const text = statusLine(this.attempts, this.lastActivity, this.options.now());
    const limit = this.options.columns() - 1;
    return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
  }
}
