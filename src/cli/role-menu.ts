import type { Role, RoleChoice } from "../config/config.ts";
import { choiceProblems } from "../config/roles.ts";
import { agentsForRole } from "../workers/agents.ts";
import type { AgentKind } from "../workers/types.ts";

export const SUGGESTED_MODELS: Record<AgentKind, string[]> = {
  "claude-code": ["opus", "sonnet", "haiku"],
  opencode: [
    "opencode-go/kimi-k3",
    "opencode-go/glm-5.3",
    "opencode-go/deepseek-v4-pro",
    "opencode-go/qwen3.8-max",
    "opencode-go/minimax-m3",
  ],
};

export const ROLE_LABELS: Record<Role, string> = {
  workers: "workers",
  verifier: "independent verifier",
  tester: "acceptance tester",
  refinement: "refinement",
};

export type RoleOrigin = "config" | "paused run" | "flag" | "chosen";

export interface RoleEntry {
  role: Role;
  offered: AgentKind[];
  choice?: RoleChoice;
  origin?: RoleOrigin;
}

export type Annotate = (entries: RoleEntry[]) => Partial<Record<Role, string[]>>;

export interface MenuOption {
  agent: AgentKind;
  model?: string;
}

export interface RoleMenu {
  options: MenuOption[];
  selected: number;
}

export interface RoleStepQuestion {
  role: Role;
  offered: AgentKind[];
  preselected?: RoleChoice;
}

export function roleMenu(question: RoleStepQuestion, models: Record<AgentKind, string[]>): RoleMenu {
  const { offered, preselected } = question;
  const options = offered.flatMap((agent): MenuOption[] => {
    const known = models[agent];
    const extra = preselected?.agent === agent && !known.includes(preselected.model) ? [preselected.model] : [];
    return [...[...extra, ...known].map((model) => ({ agent, model })), { agent }];
  });
  const index = options.findIndex((option) => option.agent === preselected?.agent && option.model === preselected?.model);
  return { options, selected: Math.max(index, 0) };
}

export function moveSelection(selected: number, count: number, key: "up" | "down"): number {
  return (selected + (key === "down" ? 1 : count - 1)) % count;
}

export interface MenuInput {
  roles: Role[];
  flagged: Partial<Record<Role, RoleChoice>>;
  defaults: Partial<Record<Role, RoleChoice>>;
  defaultOrigin: (role: Role) => RoleOrigin;
}

export function menuEntries({ roles, flagged, defaults, defaultOrigin }: MenuInput): RoleEntry[] {
  return roles.map((role): RoleEntry => {
    const offered = agentsForRole(role);
    const flag = flagged[role];
    if (flag !== undefined) return { role, offered, choice: flag, origin: "flag" };
    const fallback = defaults[role];
    if (fallback !== undefined) return { role, offered, choice: fallback, origin: defaultOrigin(role) };
    return { role, offered };
  });
}

export type MenuKey =
  | "up"
  | "down"
  | "left"
  | "right"
  | "enter"
  | "escape"
  | "backspace"
  | "ctrl-c"
  | { char: string };

export type MenuView =
  | { kind: "summary" }
  | { kind: "step"; options: MenuOption[]; cursor: number }
  | { kind: "typing"; agent: AgentKind; text: string; problems: string[] };

export interface MenuState {
  entries: RoleEntry[];
  models: Record<AgentKind, string[]>;
  annotate: Annotate;
  selected: number;
  view: MenuView;
  outcome: "open" | "started" | "cancelled";
}

const NO_NOTES: Annotate = () => ({});

export function initialMenu(
  entries: RoleEntry[],
  models: Record<AgentKind, string[]>,
  annotate: Annotate = NO_NOTES,
): MenuState {
  return { entries, models, annotate, selected: editable(entries).at(0) ?? -1, view: { kind: "summary" }, outcome: "open" };
}

export function menuChoices(state: MenuState): Partial<Record<Role, RoleChoice>> {
  return Object.fromEntries(state.entries.flatMap((entry) => (entry.choice ? [[entry.role, entry.choice]] : [])));
}

export function reduceMenu(state: MenuState, key: MenuKey): MenuState {
  if (state.outcome !== "open") return state;
  if (key === "ctrl-c") return { ...state, outcome: "cancelled" };
  if (state.view.kind === "summary") return reduceSummary(state, key);
  if (state.view.kind === "step") return reduceStep(state, state.view, key);
  return reduceTyping(state, state.view, key);
}

function editable(entries: RoleEntry[]): number[] {
  return entries.flatMap((entry, index) => (entry.origin === "flag" ? [] : [index]));
}

function reduceSummary(state: MenuState, key: MenuKey): MenuState {
  if (key === "up" || key === "down") {
    const indexes = editable(state.entries);
    if (indexes.length === 0) return state;
    const at = indexes.indexOf(state.selected);
    return { ...state, selected: indexes[moveSelection(Math.max(at, 0), indexes.length, key)] as number };
  }
  if (key === "right") return state.selected >= 0 ? openStep(state, state.selected) : state;
  if (key === "enter") {
    const missing = state.entries.findIndex((entry) => entry.choice === undefined);
    return missing >= 0 ? openStep(state, missing) : { ...state, outcome: "started" };
  }
  return state;
}

function openStep(state: MenuState, index: number): MenuState {
  const entry = state.entries[index] as RoleEntry;
  const menu = roleMenu(
    { role: entry.role, offered: entry.offered, ...(entry.choice ? { preselected: entry.choice } : {}) },
    state.models,
  );
  return { ...state, selected: index, view: { kind: "step", options: menu.options, cursor: menu.selected } };
}

function reduceStep(state: MenuState, view: Extract<MenuView, { kind: "step" }>, key: MenuKey): MenuState {
  if (key === "left" || key === "escape") return { ...state, view: { kind: "summary" } };
  if (key === "up" || key === "down") {
    return { ...state, view: { ...view, cursor: moveSelection(view.cursor, view.options.length, key) } };
  }
  if (key === "enter") {
    const option = view.options[view.cursor] as MenuOption;
    if (option.model === undefined) return { ...state, view: { kind: "typing", agent: option.agent, text: "", problems: [] } };
    return choose(state, { agent: option.agent, model: option.model });
  }
  return state;
}

function reduceTyping(state: MenuState, view: Extract<MenuView, { kind: "typing" }>, key: MenuKey): MenuState {
  if (key === "left" || key === "escape") return { ...state, view: { kind: "summary" } };
  if (key === "backspace") return { ...state, view: { ...view, text: view.text.slice(0, -1), problems: [] } };
  if (typeof key === "object") return { ...state, view: { ...view, text: view.text + key.char, problems: [] } };
  if (key !== "enter") return state;
  const model = view.text.trim();
  if (model === "") return state;
  const entry = state.entries[state.selected] as RoleEntry;
  const problems = choiceProblems(entry.role, { agent: view.agent, model });
  if (problems.length > 0) return { ...state, view: { ...view, problems } };
  return choose(state, { agent: view.agent, model });
}

function choose(state: MenuState, choice: RoleChoice): MenuState {
  const entries = state.entries.map((entry, index): RoleEntry => {
    if (index !== state.selected) return entry;
    const unchanged = entry.choice?.agent === choice.agent && entry.choice.model === choice.model;
    return unchanged ? entry : { ...entry, choice, origin: "chosen" };
  });
  return { ...state, entries, view: { kind: "summary" } };
}

export function renderMenu(state: MenuState): string[] {
  const { view } = state;
  if (view.kind === "summary") return renderSummary(state);
  const entry = state.entries[state.selected] as RoleEntry;
  if (view.kind === "step") return renderStep(entry, view);
  const hint = view.agent === "opencode" ? " (opencode-go/…)" : "";
  return [`Model of ${view.agent}${hint}: ${view.text}`, ...view.problems];
}

function renderSummary(state: MenuState): string[] {
  const notes = state.annotate(state.entries);
  const width = Math.max(...state.entries.map((entry) => ROLE_LABELS[entry.role].length)) + 3;
  const lines = state.entries.flatMap((entry, index) => {
    const value = entry.choice ? `${entry.choice.agent} ${entry.choice.model}` : "not chosen";
    const origin = entry.origin ? ` (${entry.origin})` : "";
    const marker = index === state.selected ? "❯" : " ";
    return [
      `${marker} ${`${ROLE_LABELS[entry.role]}:`.padEnd(width)}${value}${origin}`,
      ...(notes[entry.role] ?? []).map((note) => `  ${note}`),
    ];
  });
  const missing = state.entries.some((entry) => entry.choice === undefined);
  const change = editable(state.entries).length > 0 ? " · → to change a role" : "";
  return [...lines, `${missing ? "Enter to choose the missing roles" : "Enter to start"}${change}`];
}

function renderStep(entry: RoleEntry, view: Extract<MenuView, { kind: "step" }>): string[] {
  const options = view.options.map((option, index) => {
    const marker = index === view.cursor ? "❯" : " ";
    const current = option.agent === entry.choice?.agent && option.model === entry.choice?.model ? " (current)" : "";
    return `${marker} ${option.agent.padEnd(12)} ${option.model ?? "other model…"}${current}`;
  });
  return [`Agent and model of the ${ROLE_LABELS[entry.role]} (↑/↓ move · Enter choose · ← back):`, ...options];
}
