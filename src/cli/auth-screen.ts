import { emitKeypressEvents } from "node:readline";
import { menuKey } from "./ask-role.ts";
import type { MenuScreen } from "./auth-menu.ts";
import type { MenuKey } from "./role-menu.ts";

interface Keypress {
  name?: string;
  ctrl?: boolean;
  sequence?: string;
}

export function terminalMenuScreen(): MenuScreen {
  const { stdin, stdout } = process;
  const pending: MenuKey[] = [];
  let waiting: ((key: MenuKey) => void) | null = null;
  let drawn = 0;
  let listening = false;
  const onKey = (text: string | undefined, key: Keypress) => {
    const pressed = menuKey(text, key);
    if (pressed === null) return;
    if (waiting === null) pending.push(pressed);
    else {
      const resolve = waiting;
      waiting = null;
      resolve(pressed);
    }
  };
  return {
    open() {
      if (listening) return;
      listening = true;
      drawn = 0;
      emitKeypressEvents(stdin);
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("keypress", onKey);
    },
    close() {
      if (!listening) return;
      listening = false;
      stdin.off("keypress", onKey);
      stdin.setRawMode(false);
      stdin.pause();
      pending.length = 0;
    },
    show(lines) {
      if (drawn > 0) stdout.write(`\x1b[${drawn}A\r\x1b[J`);
      for (const line of lines) stdout.write(`${line.startsWith("❯") ? `\x1b[36m${line}\x1b[0m` : line}\n`);
      drawn = lines.length;
    },
    nextKey() {
      const queued = pending.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
  };
}
