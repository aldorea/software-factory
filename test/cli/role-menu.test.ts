import { describe, expect, it } from "vitest";
import {
  initialMenu,
  menuChoices,
  menuEntries,
  moveSelection,
  reduceMenu,
  renderMenu,
  roleMenu,
  type MenuKey,
  type RoleEntry,
} from "../../src/cli/role-menu.ts";

const MODELS = { "claude-code": ["opus", "sonnet"], opencode: ["opencode-go/kimi-k3"] };

describe("roleMenu", () => {
  it("should offer every model of every offered agent, then a way to type another model of each agent", () => {
    const menu = roleMenu({ role: "verifier", offered: ["claude-code", "opencode"] }, MODELS);

    expect(menu.options).toEqual([
      { agent: "claude-code", model: "opus" },
      { agent: "claude-code", model: "sonnet" },
      { agent: "claude-code" },
      { agent: "opencode", model: "opencode-go/kimi-k3" },
      { agent: "opencode" },
    ]);
    expect(menu.selected).toBe(0);
  });

  it("should select the preselected choice", () => {
    const menu = roleMenu(
      { role: "workers", offered: ["claude-code", "opencode"], preselected: { agent: "opencode", model: "opencode-go/kimi-k3" } },
      MODELS,
    );

    expect(menu.options[menu.selected]).toEqual({ agent: "opencode", model: "opencode-go/kimi-k3" });
  });

  it("should add and select a preselected model the list does not know, so a default from the config is one key away", () => {
    const menu = roleMenu(
      { role: "tester", offered: ["claude-code", "opencode"], preselected: { agent: "opencode", model: "opencode-go/glm-5.3" } },
      MODELS,
    );

    expect(menu.options[menu.selected]).toEqual({ agent: "opencode", model: "opencode-go/glm-5.3" });
    expect(menu.options.filter((option) => option.agent === "opencode")).toEqual([
      { agent: "opencode", model: "opencode-go/glm-5.3" },
      { agent: "opencode", model: "opencode-go/kimi-k3" },
      { agent: "opencode" },
    ]);
  });

  it("should leave out the agents the role does not offer", () => {
    const menu = roleMenu({ role: "workers", offered: ["claude-code"], preselected: { agent: "opencode", model: "opencode-go/kimi-k3" } }, MODELS);

    expect(menu.options.map((option) => option.agent)).toEqual(["claude-code", "claude-code", "claude-code"]);
    expect(menu.selected).toBe(0);
  });
});

describe("moveSelection", () => {
  it("should move down and up one option", () => {
    expect(moveSelection(1, 4, "down")).toBe(2);
    expect(moveSelection(1, 4, "up")).toBe(0);
  });

  it("should wrap around at both ends", () => {
    expect(moveSelection(3, 4, "down")).toBe(0);
    expect(moveSelection(0, 4, "up")).toBe(3);
  });
});

const BOTH = ["claude-code", "opencode"] as const;

const ENTRIES: RoleEntry[] = [
  { role: "workers", offered: [...BOTH], choice: { agent: "claude-code", model: "opus" }, origin: "config" },
  { role: "verifier", offered: [...BOTH], choice: { agent: "opencode", model: "opencode-go/glm-5.3" }, origin: "config" },
  { role: "tester", offered: [...BOTH], choice: { agent: "claude-code", model: "sonnet" }, origin: "flag" },
];

function press(entries: RoleEntry[], ...keys: MenuKey[]) {
  return keys.reduce(reduceMenu, initialMenu(entries, MODELS));
}

const chars = (text: string): MenuKey[] => [...text].map((char) => ({ char }));

describe("the role menu: the summary", () => {
  it("should render the role names of the glossary, each with the origin of its value, as in the design", () => {
    expect(renderMenu(initialMenu(ENTRIES, MODELS))).toEqual([
      "❯ workers:               claude-code opus (config)",
      "  independent verifier:  opencode opencode-go/glm-5.3 (config)",
      "  acceptance tester:     claude-code sonnet (flag)",
      "Enter to start · → to change a role",
    ]);
  });

  it("should start with the default choices when Enter is pressed on the summary", () => {
    const state = press(ENTRIES, "enter");

    expect(state.outcome).toBe("started");
    expect(menuChoices(state)).toEqual({
      workers: { agent: "claude-code", model: "opus" },
      verifier: { agent: "opencode", model: "opencode-go/glm-5.3" },
      tester: { agent: "claude-code", model: "sonnet" },
    });
  });

  it("should do nothing on Esc, ← or a letter, so the developer cannot start or leave by accident", () => {
    const before = initialMenu(ENTRIES, MODELS);

    expect(reduceMenu(before, "escape")).toEqual(before);
    expect(reduceMenu(before, "left")).toEqual(before);
    expect(reduceMenu(before, { char: "x" })).toEqual(before);
  });

  it("should move the selection over the roles no flag fixed, wrapping around and skipping the role with a flag", () => {
    expect(press(ENTRIES, "down").selected).toBe(1);
    expect(press(ENTRIES, "down", "down").selected).toBe(0);
    expect(press(ENTRIES, "up").selected).toBe(1);
  });

  it("should not open the step of a role fixed by a flag, and select nothing when every role has a flag", () => {
    const locked = ENTRIES.map((entry): RoleEntry => ({ ...entry, origin: "flag" }));
    const state = press(locked, "down", "right");

    expect(state.selected).toBe(-1);
    expect(state.view).toEqual({ kind: "summary" });
    expect(renderMenu(state).at(-1)).toBe("Enter to start");
    expect(press(locked, "enter").outcome).toBe("started");
  });

  it("should cancel on Ctrl-C at the summary, in a step and while typing a model", () => {
    expect(press(ENTRIES, "ctrl-c").outcome).toBe("cancelled");
    expect(press(ENTRIES, "right", "ctrl-c").outcome).toBe("cancelled");
    expect(press(ENTRIES, "right", "down", "down", "enter", "ctrl-c").outcome).toBe("cancelled");
  });

  it("should ignore every key once the menu started or was cancelled", () => {
    const started = press(ENTRIES, "enter");

    expect(reduceMenu(started, "right")).toBe(started);
  });

  it("should print the notes the annotation gives under the line of their role, and drop them when the choice changes", () => {
    const annotate = (entries: RoleEntry[]) =>
      entries[0]?.choice?.agent === "claude-code" ? { workers: ["⚠ claude-code plan limit until 14:00"] } : {};
    const state = initialMenu(ENTRIES, MODELS, annotate);

    expect(renderMenu(state)[1]).toBe("  ⚠ claude-code plan limit until 14:00");
    const keys: MenuKey[] = ["right", "down", "down", "down", "enter"];
    const changed = keys.reduce(reduceMenu, state);
    expect(changed.entries[0]?.choice?.agent).toBe("opencode");
    expect(renderMenu(changed).join("\n")).not.toContain("plan limit");
  });
});

describe("the role menu: a step", () => {
  it("should open the step of the selected role on →, with the current choice selected and marked", () => {
    const state = press(ENTRIES, "down", "right");

    expect(state.view).toMatchObject({ kind: "step", cursor: 3 });
    expect(renderMenu(state)).toEqual([
      "Agent and model of the independent verifier (↑/↓ move · Enter choose · ← back):",
      "  claude-code  opus",
      "  claude-code  sonnet",
      "  claude-code  other model…",
      "❯ opencode     opencode-go/glm-5.3 (current)",
      "  opencode     opencode-go/kimi-k3",
      "  opencode     other model…",
    ]);
  });

  it("should keep every choice when → is followed by ←, by Esc, or by a move that was not confirmed", () => {
    for (const back of ["left", "escape"] as const) {
      const state = press(ENTRIES, "right", "down", back);

      expect(state.view).toEqual({ kind: "summary" });
      expect(state.entries).toEqual(ENTRIES);
    }
  });

  it("should set the picked pair on Enter and go back to the summary, marking it as chosen in the menu", () => {
    const state = press(ENTRIES, "right", "down", "enter");

    expect(state.view).toEqual({ kind: "summary" });
    expect(renderMenu(state)[0]).toBe("❯ workers:               claude-code sonnet (chosen)");
    expect(state.entries[1]).toEqual(ENTRIES[1]);
  });

  it("should keep the origin when the picked pair is the current one", () => {
    expect(press(ENTRIES, "right", "enter").entries).toEqual(ENTRIES);
  });

  it("should set the choice of the selected role and leave the others as they were", () => {
    const state = press(ENTRIES, "down", "right", "up", "up", "up", "enter");

    expect(state.entries[0]).toEqual(ENTRIES[0]);
    expect(state.entries[1]).toEqual({ ...ENTRIES[1], choice: { agent: "claude-code", model: "opus" }, origin: "chosen" });
  });
});

describe("the role menu: typing another model", () => {
  const toTyping = (...keys: MenuKey[]) => press(ENTRIES, "right", "down", "down", "enter", ...keys);

  it("should open the typing of the agent of the entry", () => {
    expect(toTyping().view).toEqual({ kind: "typing", agent: "claude-code", text: "", problems: [] });
  });

  it("should set the typed model on Enter", () => {
    const state = toTyping(...chars("fable"), "enter");

    expect(state.entries[0]?.choice).toEqual({ agent: "claude-code", model: "fable" });
    expect(state.view).toEqual({ kind: "summary" });
  });

  it("should edit the text with backspace", () => {
    const state = toTyping(...chars("fablex"), "backspace", "enter");

    expect(state.entries[0]?.choice?.model).toBe("fable");
  });

  it("should reject an OpenCode model outside opencode-go/ and stay in the typing, because the other providers are pay per use", () => {
    const state = press(ENTRIES, "right", "down", "down", "down", "down", "enter", ...chars("opencode/kimi-k2"), "enter");

    expect(state.entries[0]?.choice).toEqual({ agent: "claude-code", model: "opus" });
    expect(state.view).toMatchObject({ kind: "typing", agent: "opencode" });
    expect(renderMenu(state).at(-1)).toContain("must be an opencode-go/ model");
  });

  it("should accept an opencode-go/ model typed by hand", () => {
    const state = press(ENTRIES, "right", "down", "down", "down", "down", "enter", ...chars("opencode-go/new-model"), "enter");

    expect(state.entries[0]?.choice).toEqual({ agent: "opencode", model: "opencode-go/new-model" });
  });

  it("should wait for a model on Enter with an empty text", () => {
    expect(toTyping("enter").view).toMatchObject({ kind: "typing", text: "" });
  });

  it("should go back to the summary on ← or Esc from the typing, keeping the choice", () => {
    for (const back of ["left", "escape"] as const) {
      const state = toTyping(...chars("fab"), back);

      expect(state.view).toEqual({ kind: "summary" });
      expect(state.entries).toEqual(ENTRIES);
    }
  });
});

describe("the role menu: a role with no default", () => {
  const first = ENTRIES[0] as RoleEntry;
  const MISSING: RoleEntry[] = [{ role: first.role, offered: first.offered }, ENTRIES[1] as RoleEntry];

  it("should show the role as not chosen and open its step on Enter instead of starting", () => {
    const state = press(MISSING, "enter");

    expect(renderMenu(initialMenu(MISSING, MODELS))[0]).toBe("❯ workers:               not chosen");
    expect(state.outcome).toBe("open");
    expect(state.view).toMatchObject({ kind: "step", cursor: 0 });
  });

  it("should start once the missing role is chosen", () => {
    const state = press(MISSING, "enter", "enter", "enter");

    expect(state.outcome).toBe("started");
    expect(menuChoices(state).workers).toEqual({ agent: "claude-code", model: "opus" });
  });
});

describe("menuEntries", () => {
  it("should take the value from the flag, else from the default with its origin, and leave the role without either unset", () => {
    const entries = menuEntries({
      roles: ["workers", "verifier", "tester"],
      flagged: { workers: { agent: "claude-code", model: "haiku" } },
      defaults: { workers: { agent: "claude-code", model: "opus" }, verifier: { agent: "claude-code", model: "sonnet" } },
      defaultOrigin: () => "paused run",
    });

    expect(entries.map(({ role, choice, origin }) => [role, choice?.model, origin])).toEqual([
      ["workers", "haiku", "flag"],
      ["verifier", "sonnet", "paused run"],
      ["tester", undefined, undefined],
    ]);
  });

  it("should offer each role the agents that meet it", () => {
    const [entry] = menuEntries({ roles: ["verifier"], flagged: {}, defaults: {}, defaultOrigin: () => "config" });

    expect(entry?.offered).toEqual(["claude-code", "opencode"]);
  });
});
