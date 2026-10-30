import { emitKeypressEvents, createInterface } from "node:readline";
import { menuKey } from "./ask-role.ts";
import type { MenuKey } from "./role-menu.ts";

export interface SecretState {
  value: string;
  outcome: "open" | "done" | "cancelled";
}

export function reduceSecret(state: SecretState, key: MenuKey): SecretState {
  if (state.outcome !== "open") return state;
  if (key === "enter") return { ...state, outcome: "done" };
  if (key === "escape" || key === "ctrl-c") return { ...state, outcome: "cancelled" };
  if (key === "backspace") return { ...state, value: state.value.slice(0, -1) };
  if (typeof key === "object") return { ...state, value: state.value + key.char };
  return state;
}

export function readSecretInTerminal(prompt: string): Promise<string | null> {
  const { stdin, stdout } = process;
  stdout.write(prompt);
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  let state: SecretState = { value: "", outcome: "open" };
  return new Promise((resolve) => {
    const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
      const pressed = menuKey(text, key);
      if (pressed === null) return;
      state = reduceSecret(state, pressed);
      if (state.outcome === "open") return;
      stdin.off("keypress", onKey);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      resolve(state.outcome === "done" ? state.value : null);
    };
    stdin.on("keypress", onKey);
  });
}

export async function readLineFromStdin(): Promise<string | null> {
  const lines = createInterface({ input: process.stdin, terminal: false });
  try {
    for await (const line of lines) return line.replace(/\r$/, "");
    return null;
  } finally {
    lines.close();
  }
}

export async function confirmInTerminal(question: string): Promise<boolean> {
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => lines.question(question, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    lines.close();
  }
}
