import type { GitHub } from "../github/github.ts";
import type { ActivityEvent, WorkerRunner } from "../workers/types.ts";
import type { Verifier } from "./verifier.ts";

export interface Clock {
  now(): Date;
}

export interface Notification {
  title: string;
  message: string;
  url?: string;
}

export interface Notifier {
  notify(notification: Notification): Promise<void>;
}

export interface ActivityEntry {
  source: string;
  at: Date;
  event: ActivityEvent;
}

export interface RunPorts {
  runner: WorkerRunner;
  verifier: Verifier;
  github: GitHub;
  notifier: Notifier;
  clock: Clock;
  progress?(line: string): void;
  activity?(entry: ActivityEntry): void;
}
