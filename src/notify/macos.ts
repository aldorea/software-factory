import type { Notification, Notifier } from "../coordinator/ports.ts";
import { execOk } from "../workers/sh.ts";

const SCRIPT = [
  "on run argv",
  "display notification (item 2 of argv) with title (item 1 of argv)",
  "end run",
];

export function macosNotifier(command = "osascript"): Notifier {
  return {
    async notify(notification: Notification): Promise<void> {
      const message = notification.url ? `${notification.message}\n${notification.url}` : notification.message;
      await execOk(command, [...SCRIPT.flatMap((line) => ["-e", line]), notification.title, message]);
    },
  };
}
