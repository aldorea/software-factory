import type { AgentKind } from "../workers/types.ts";
import type { RoleQuestion } from "./main.ts";

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

export interface MenuOption {
  agent: AgentKind;
  model?: string;
}

export interface RoleMenu {
  options: MenuOption[];
  selected: number;
}

export function roleMenu(question: RoleQuestion, models: Record<AgentKind, string[]>): RoleMenu {
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
