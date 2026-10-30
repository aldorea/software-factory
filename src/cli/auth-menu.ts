import { credentialOrigin, CREDENTIAL_VARIABLES, type Credentials } from "../config/credentials.ts";
import { deleteCredential, loadCredentials } from "../config/credentials-store.ts";
import { AGENT_KINDS } from "../workers/agents.ts";
import type { AgentKind } from "../workers/types.ts";
import type { PromptOutcome } from "./auth.ts";
import { moveSelection, type MenuKey } from "./role-menu.ts";
import { renderSetup, type SetupLine } from "./setup-render.ts";

export interface AuthRow {
  agent: AgentKind;
  variable: string;
  origin: string;
  saved: boolean;
}

export interface AuthMenuState {
  rows: AuthRow[];
  selected: number;
  notice: SetupLine[];
  outcome: "open" | "set" | "delete" | "quit";
}

export interface MenuScreen {
  open(): void;
  close(): void;
  show(lines: string[]): void;
  nextKey(): Promise<MenuKey>;
}

export interface AuthMenuOptions {
  credentialsPath: string;
  environment: Record<string, string | undefined>;
  screen: MenuScreen;
  color: boolean;
  prompt(agent: AgentKind): Promise<PromptOutcome>;
}

export type AuthMenuResult = { ok: true } | { ok: false; problem: string };

export function authRows(environment: Record<string, string | undefined>, saved: Credentials): AuthRow[] {
  return AGENT_KINDS.map((agent) => ({
    agent,
    variable: CREDENTIAL_VARIABLES[agent],
    origin: credentialOrigin(agent, environment, saved),
    saved: saved[agent] !== undefined,
  }));
}

export function initialAuthMenu(rows: AuthRow[], selected = 0, notice: SetupLine[] = []): AuthMenuState {
  return { rows, selected, notice, outcome: "open" };
}

export function reduceAuthMenu(state: AuthMenuState, key: MenuKey): AuthMenuState {
  if (state.outcome !== "open") return state;
  if (key === "escape" || key === "ctrl-c") return { ...state, outcome: "quit" };
  if (key === "up" || key === "down") {
    return { ...state, selected: moveSelection(state.selected, state.rows.length, key), notice: [] };
  }
  if (key === "enter") return { ...state, outcome: "set" };
  if (typeof key === "object" && key.char.toLowerCase() === "d" && state.rows[state.selected]?.saved === true) {
    return { ...state, outcome: "delete" };
  }
  return state;
}

export function renderAuthMenu(state: AuthMenuState): string[] {
  const agentWidth = Math.max(...state.rows.map((row) => row.agent.length)) + 2;
  const variableWidth = Math.max(...state.rows.map((row) => row.variable.length)) + 2;
  const lines = state.rows.map((row, index) => {
    const marker = index === state.selected ? "❯" : " ";
    return `${marker} ${row.agent.padEnd(agentWidth)}${row.variable.padEnd(variableWidth)}${row.origin}`;
  });
  return [...lines, "Enter to set · d to delete · Esc to quit"];
}

export async function runAuthMenu(options: AuthMenuOptions): Promise<AuthMenuResult> {
  const { credentialsPath, environment, screen, color, prompt } = options;
  const load = async () => loadCredentials(credentialsPath, environment);
  const first = await load();
  if (!first.ok) return first;
  let state = initialAuthMenu(authRows(environment, first.saved));
  screen.open();
  try {
    for (;;) {
      screen.show([...renderAuthMenu(state), ...renderSetup(state.notice, color)]);
      state = reduceAuthMenu(state, await screen.nextKey());
      if (state.outcome === "open") continue;
      if (state.outcome === "quit") return { ok: true };
      const row = state.rows[state.selected] as AuthRow;
      let notice: SetupLine[];
      if (state.outcome === "set") {
        screen.close();
        const outcome = await prompt(row.agent);
        screen.open();
        notice = outcome.kind === "saved" || outcome.kind === "cancelled" ? [] : [{ kind: "fail", text: outcome.problem }];
      } else {
        const deleted = await deleteCredential(credentialsPath, row.agent);
        notice = deleted.ok
          ? [{ kind: "ok", text: `deleted ${row.variable} from ${deleted.path}` }]
          : [{ kind: "fail", text: deleted.problem }];
      }
      const reloaded = await load();
      if (!reloaded.ok) return reloaded;
      state = initialAuthMenu(authRows(environment, reloaded.saved), state.selected, notice);
    }
  } finally {
    screen.close();
  }
}
