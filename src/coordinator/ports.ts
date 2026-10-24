import type { GitHub } from "../github/github.ts";
import type { WorkerRunner } from "../workers/types.ts";

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

export interface RunPorts {
  runner: WorkerRunner;
  github: GitHub;
  notifier: Notifier;
  clock: Clock;
}
