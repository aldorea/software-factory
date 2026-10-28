import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import type { RoleChoice } from "../config/config.ts";
import { SUGGESTED_MODELS } from "../workers/agents.ts";
import type { AgentKind } from "../workers/types.ts";
import type { RoleQuestion } from "./main.ts";
import { moveSelection, roleMenu, type MenuOption } from "./role-menu.ts";

const ROLE_NAMES = { workers: "the workers", verifier: "the independent verifier", tester: "the acceptance tester" } as const;

export async function askRoleInTerminal(question: RoleQuestion): Promise<RoleChoice> {
  const menu = roleMenu(question, SUGGESTED_MODELS);
  process.stdout.write(`Agent and model of ${ROLE_NAMES[question.role]} (↑/↓, Enter):\n`);
  const picked = await pick(menu.options, menu.selected);
  if (picked.model !== undefined) return { agent: picked.agent, model: picked.model };
  return { agent: picked.agent, model: await typeModel(picked.agent) };
}

function pick(options: MenuOption[], initial: number): Promise<MenuOption> {
  const { stdin, stdout } = process;
  let selected = initial;
  const draw = (first: boolean) => {
    if (!first) stdout.write(`\x1b[${options.length}A`);
    options.forEach((option, index) => {
      const marker = index === selected ? "\x1b[36m❯" : " ";
      stdout.write(`\x1b[2K${marker} ${option.agent.padEnd(12)} ${option.model ?? "other model…"}\x1b[0m\n`);
    });
  };
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  draw(true);
  return new Promise((resolve) => {
    const done = () => {
      stdin.off("keypress", onKey);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onKey = (_text: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl === true && key.name === "c") {
        done();
        process.kill(process.pid, "SIGINT");
        return;
      }
      if (key.name === "up" || key.name === "down") {
        selected = moveSelection(selected, options.length, key.name);
        draw(false);
      } else if (key.name === "return") {
        done();
        resolve(options[selected] as MenuOption);
      }
    };
    stdin.on("keypress", onKey);
  });
}

async function typeModel(agent: AgentKind): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hint = agent === "opencode" ? " (opencode-go/…)" : "";
    let model = "";
    while (model === "") model = (await terminal.question(`Model of ${agent}${hint}: `)).trim();
    return model;
  } finally {
    terminal.close();
  }
}
