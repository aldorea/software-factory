import type { Notification, Notifier } from "../../src/coordinator/ports.ts";

export class FakeNotifier implements Notifier {
  readonly sent: Notification[] = [];

  async notify(notification: Notification): Promise<void> {
    this.sent.push(notification);
  }
}
