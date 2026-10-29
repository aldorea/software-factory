import { describe, expect, it } from "vitest";
import { menuKey } from "../../src/cli/ask-role.ts";

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
