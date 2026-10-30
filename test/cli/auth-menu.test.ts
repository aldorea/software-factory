import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PromptOutcome } from "../../src/cli/auth.ts";
import {
  authRows,
  initialAuthMenu,
  reduceAuthMenu,
  renderAuthMenu,
  runAuthMenu,
  type AuthMenuState,
  type MenuScreen,
} from "../../src/cli/auth-menu.ts";
import type { MenuKey } from "../../src/cli/role-menu.ts";
import { saveCredential } from "../../src/config/credentials-store.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

function press(state: AuthMenuState, keys: MenuKey[]): AuthMenuState {
  return keys.reduce(reduceAuthMenu, state);
}

const rows = authRows({}, { "claude-code": "sk-ant-oat01-xxxxa1f3" });

describe("reduceAuthMenu", () => {
  it("should start on the first agent with the menu open", () => {
    const state = initialAuthMenu(rows);

    expect(state.selected).toBe(0);
    expect(state.outcome).toBe("open");
  });

  it("should move the selection with the arrows and wrap around", () => {
    expect(press(initialAuthMenu(rows), ["down"]).selected).toBe(1);
    expect(press(initialAuthMenu(rows), ["down", "down"]).selected).toBe(0);
    expect(press(initialAuthMenu(rows), ["up"]).selected).toBe(1);
  });

  it("should ask for the prompt of the selected agent on Enter", () => {
    const state = press(initialAuthMenu(rows), ["down", "enter"]);

    expect(state.outcome).toBe("set");
    expect(state.rows[state.selected]?.agent).toBe("opencode");
  });

  it("should ask to delete the saved credential of the selected agent on d", () => {
    const state = press(initialAuthMenu(rows), [{ char: "d" }]);

    expect(state.outcome).toBe("delete");
    expect(state.rows[state.selected]?.agent).toBe("claude-code");
  });

  it("should ignore d on an agent with nothing saved, so nothing is deleted by a slip", () => {
    const state = press(initialAuthMenu(rows), ["down", { char: "d" }]);

    expect(state.outcome).toBe("open");
  });

  it("should ignore d on an agent whose credential comes from the environment and has no saved one", () => {
    const fromEnvironment = authRows({ OPENCODE_API_KEY: "e" }, {});

    expect(press(initialAuthMenu(fromEnvironment), ["down", { char: "d" }]).outcome).toBe("open");
  });

  it("should quit on Esc and on Ctrl-C without asking for anything", () => {
    expect(press(initialAuthMenu(rows), ["escape"]).outcome).toBe("quit");
    expect(press(initialAuthMenu(rows), ["ctrl-c"]).outcome).toBe("quit");
  });

  it("should ignore other keys and every key after it finished", () => {
    const open = initialAuthMenu(rows);
    expect(press(open, [{ char: "x" }, "left", "backspace"])).toEqual(open);
    const done = press(open, ["escape"]);
    expect(press(done, ["down", "enter"])).toEqual(done);
  });
});

describe("authRows and renderAuthMenu", () => {
  it("should list each agent with its variable and where its credential comes from", () => {
    const state = initialAuthMenu(authRows({ OPENCODE_API_KEY: "e" }, { "claude-code": "sk-ant-oat01-xxxxa1f3" }));

    expect(renderAuthMenu(state)).toEqual([
      "❯ claude-code  CLAUDE_CODE_OAUTH_TOKEN  saved (…a1f3)",
      "  opencode     OPENCODE_API_KEY         from environment (wins over saved)",
      "Enter to set · d to delete · Esc to quit",
    ]);
  });

  it("should say not set for an agent with no credential, and move the marker with the selection", () => {
    const state = press(initialAuthMenu(authRows({}, {})), ["down"]);

    expect(renderAuthMenu(state)).toEqual([
      "  claude-code  CLAUDE_CODE_OAUTH_TOKEN  not set",
      "❯ opencode     OPENCODE_API_KEY         not set",
      "Enter to set · d to delete · Esc to quit",
    ]);
  });

  it("should never show more than the last 4 characters of a saved credential", () => {
    const text = renderAuthMenu(initialAuthMenu(rows)).join("\n");

    expect(text).not.toContain("sk-ant");
    expect(text).not.toContain("xxxx");
  });
});

async function credentialsPath(): Promise<string> {
  return join(await temp.make("auth-menu-"), "software-factory", "credentials");
}

function scripted(keys: MenuKey[]) {
  const shown: string[][] = [];
  const log: string[] = [];
  const queue = [...keys];
  const screen: MenuScreen = {
    open: () => log.push("open"),
    close: () => log.push("close"),
    show: (lines) => shown.push(lines),
    nextKey: async () => queue.shift() ?? "escape",
  };
  return { screen, shown, log };
}

describe("runAuthMenu", () => {
  it("should draw the origins from the environment and a real file, and change nothing when Esc quits", async () => {
    const path = await credentialsPath();
    await saveCredential(path, "claude-code", "sk-ant-oat01-xxxxa1f3");
    const { screen, shown } = scripted(["escape"]);
    const prompted: string[] = [];

    const result = await runAuthMenu({
      credentialsPath: path,
      environment: { OPENCODE_API_KEY: "e" },
      screen,
      color: false,
      prompt: async (agent) => {
        prompted.push(agent);
        return { kind: "cancelled" };
      },
    });

    expect(result).toEqual({ ok: true });
    expect(shown[0]?.slice(0, 2)).toEqual([
      "❯ claude-code  CLAUDE_CODE_OAUTH_TOKEN  saved (…a1f3)",
      "  opencode     OPENCODE_API_KEY         from environment (wins over saved)",
    ]);
    expect(prompted).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxxxa1f3\n");
  });

  it("should release the keyboard for the prompt of the selected agent and draw the saved credential afterwards", async () => {
    const path = await credentialsPath();
    const { screen, shown } = scripted(["down", "enter", "escape"]);
    const events: string[] = [];
    const tracked: MenuScreen = {
      ...screen,
      open: () => {
        screen.open();
        events.push("open");
      },
      close: () => {
        screen.close();
        events.push("close");
      },
    };
    const prompted: string[] = [];

    await runAuthMenu({
      credentialsPath: path,
      environment: {},
      screen: tracked,
      color: false,
      prompt: async (agent): Promise<PromptOutcome> => {
        prompted.push(agent);
        events.push("prompt");
        await saveCredential(path, agent, "key-with-tail-9z9z");
        return { kind: "saved", path };
      },
    });

    expect(prompted).toEqual(["opencode"]);
    expect(events).toEqual(["open", "close", "prompt", "open", "close"]);
    expect(shown.at(-1)?.[1]).toBe("❯ opencode     OPENCODE_API_KEY         saved (…9z9z)");
  });

  it("should show the problem of a prompt that did not save and stay in the menu", async () => {
    const path = await credentialsPath();
    const { screen, shown } = scripted(["enter", "escape"]);

    const result = await runAuthMenu({
      credentialsPath: path,
      environment: {},
      screen,
      color: false,
      prompt: async () => ({ kind: "rejected", problem: "the credential is empty" }),
    });

    expect(result).toEqual({ ok: true });
    expect(shown.at(-1)?.join("\n")).toContain("✗ the credential is empty");
  });

  it("should delete only the line of the selected agent from the file on d", async () => {
    const path = await credentialsPath();
    await saveCredential(path, "claude-code", "sk-ant-oat01-xxxxa1f3");
    await saveCredential(path, "opencode", "key-with-tail-9z9z");
    const { screen, shown } = scripted([{ char: "d" }, "escape"]);

    await runAuthMenu({
      credentialsPath: path,
      environment: {},
      screen,
      color: false,
      prompt: async () => ({ kind: "cancelled" }),
    });

    expect(await readFile(path, "utf8")).toBe("OPENCODE_API_KEY=key-with-tail-9z9z\n");
    const last = shown.at(-1) ?? [];
    expect(last[0]).toBe("❯ claude-code  CLAUDE_CODE_OAUTH_TOKEN  not set");
    expect(last[1]).toBe("  opencode     OPENCODE_API_KEY         saved (…9z9z)");
    expect(last.join("\n")).toContain("✓ deleted CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("should fail closed with the chmod fix when the file can be read by others, before it draws anything", async () => {
    const path = await credentialsPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, "OPENCODE_API_KEY=old\n");
    await chmod(path, 0o644);
    const { screen, shown, log } = scripted(["escape"]);

    const result = await runAuthMenu({
      credentialsPath: path,
      environment: {},
      screen,
      color: false,
      prompt: async () => ({ kind: "cancelled" }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain(`chmod 600 ${path}`);
    expect(shown).toEqual([]);
    expect(log).toEqual([]);
  });

  it("should release the keyboard even when a step throws", async () => {
    const path = await credentialsPath();
    const { screen, log } = scripted(["enter"]);

    await expect(
      runAuthMenu({
        credentialsPath: path,
        environment: {},
        screen,
        color: false,
        prompt: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");

    expect(log.at(-1)).toBe("close");
  });
});
