import { emitKeypressEvents } from "node:readline";
import type { Role, RoleChoice } from "../config/config.ts";
import type { AgentKind } from "../workers/types.ts";
import type { KeyInput } from "./tty.ts";
import {
  credentialPrompted,
  initialMenu,
  menuChoices,
  reduceMenu,
  renderMenu,
  SUGGESTED_MODELS,
  type Annotate,
  type MenuCredentials,
  type MenuKey,
  type RoleEntry,
} from "./role-menu.ts";

interface Keypress {
  name?: string;
  ctrl?: boolean;
  sequence?: string;
}

const KEY_NAMES: Record<string, MenuKey> = {
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  return: "enter",
  enter: "enter",
  escape: "escape",
  backspace: "backspace",
};

export function menuKey(text: string | undefined, key: Keypress): MenuKey | null {
  if (key.ctrl === true && key.name === "c") return "ctrl-c";
  const named = key.name === undefined ? undefined : KEY_NAMES[key.name];
  if (named !== undefined) return named;
  if (text !== undefined && text.length === 1 && text >= " " && text !== "\x7f") return { char: text };
  return null;
}

export interface MenuIo {
  stdin: KeyInput;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export function askRolesInTerminal(
  entries: RoleEntry[],
  annotate: Annotate,
  credentials?: MenuCredentials,
  io: MenuIo = process,
): Promise<Partial<Record<Role, RoleChoice>>> {
  const { stdin, stdout, stderr } = io;
  let state = initialMenu(entries, SUGGESTED_MODELS, annotate, credentials?.missing);
  let drawn = 0;
  const erase = () => {
    if (drawn > 0) stdout.write(`\x1b[${drawn}A\r\x1b[J`);
    drawn = 0;
  };
  const draw = () => {
    erase();
    const lines = renderMenu(state);
    for (const line of lines) stdout.write(`${line.startsWith("❯") ? `\x1b[36m${line}\x1b[0m` : line}\n`);
    drawn = lines.length;
  };
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  draw();
  return new Promise((resolve) => {
    const done = () => {
      stdin.off("keypress", onKey);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const addCredential = async (agent: AgentKind) => {
      stdin.off("keypress", onKey);
      erase();
      let saved = false;
      try {
        saved = credentials === undefined ? false : await credentials.add(agent);
      } catch (error) {
        stderr.write(`✗ factory: ${(error as Error).message}\n`);
      }
      state = credentialPrompted(state, saved ? "saved" : "cancelled");
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("keypress", onKey);
      draw();
    };
    const onKey = (text: string | undefined, key: Keypress) => {
      const pressed = menuKey(text, key);
      if (pressed === null) return;
      state = reduceMenu(state, pressed);
      if (state.view.kind === "credential") {
        void addCredential(state.view.agent);
        return;
      }
      draw();
      if (state.outcome === "started") {
        done();
        resolve(menuChoices(state));
      } else if (state.outcome === "cancelled") {
        done();
        process.kill(process.pid, "SIGINT");
      }
    };
    stdin.on("keypress", onKey);
  });
}
