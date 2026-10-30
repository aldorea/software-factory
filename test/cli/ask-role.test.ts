import { describe, expect, it } from "vitest";
import { askRolesInTerminal, menuKey } from "../../src/cli/ask-role.ts";
import { fakeKeyboard, textSink, until } from "../fakes/keyboard.ts";

describe("menuKey", () => {
  it("should name the arrows, Enter, Esc and backspace the keyboard sends", () => {
    expect(menuKey(undefined, { name: "up" })).toBe("up");
    expect(menuKey(undefined, { name: "right" })).toBe("right");
    expect(menuKey("\r", { name: "return" })).toBe("enter");
    expect(menuKey("\x1b", { name: "escape" })).toBe("escape");
    expect(menuKey("\x7f", { name: "backspace" })).toBe("backspace");
  });

  it("should read Ctrl-C before any other meaning of the c key", () => {
    expect(menuKey("\x03", { name: "c", ctrl: true })).toBe("ctrl-c");
  });

  it("should pass a printable character as typed text, and ignore a control sequence with no name", () => {
    expect(menuKey("o", { name: "o" })).toEqual({ char: "o" });
    expect(menuKey("/", {})).toEqual({ char: "/" });
    expect(menuKey("\x1b[2~", { name: "insert" })).toBeNull();
  });
});

describe("askRolesInTerminal", () => {
  const MODELS_ENTRIES = [{ role: "workers" as const, offered: ["opencode" as const] }];
  const annotate = () => ({});

  it("should show the problem, keep the terminal in raw mode and keep answering keys when saving a credential throws, instead of dying with an unhandled rejection", async () => {
    const stdin = fakeKeyboard();
    const stdout = textSink();
    const stderr = textSink();
    let attempts = 0;
    const credentials = {
      missing: ["opencode" as const],
      add: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("EACCES: permission denied, mkdir '/x'");
        return true;
      },
    };

    const asking = askRolesInTerminal(MODELS_ENTRIES, annotate, credentials, { stdin, stdout: stdout.stream, stderr: stderr.stream });
    stdin.type("\r");
    await until(() => stdout.text().includes("no credential"), "the step of the role");
    stdin.type("\r");
    await until(() => stderr.text().includes("EACCES"), "the problem");

    expect(stderr.text()).toBe("✗ factory: EACCES: permission denied, mkdir '/x'\n");
    expect(stdin.raw.at(-1)).toBe(true);

    stdin.type("\r");
    await until(() => attempts === 2, "the second attempt");
    await until(() => stdout.text().includes("opencode-go/"), "the models of the saved agent");
    stdin.type("\r");
    stdin.type("\r");

    expect(await asking).toEqual({ workers: { agent: "opencode", model: expect.stringContaining("opencode-go/") } });
    expect(stdin.raw.at(-1)).toBe(false);
  });
});
