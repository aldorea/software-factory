import { describe, expect, it } from "vitest";
import { moveSelection, roleMenu } from "../../src/cli/role-menu.ts";

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
