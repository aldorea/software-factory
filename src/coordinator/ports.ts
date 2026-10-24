import type { GitHub } from "../github/github.ts";
import type { WorkerRunner } from "../workers/types.ts";
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

export interface RunPorts {
  runner: WorkerRunner;
  verifier: Verifier;
  github: GitHub;
  notifier: Notifier;
  clock: Clock;
}
