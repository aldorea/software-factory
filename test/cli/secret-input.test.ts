import { describe, expect, it } from "vitest";
import { readSecretInTerminal } from "../../src/cli/secret-input.ts";
import { fakeKeyboard, textSink } from "../fakes/keyboard.ts";

describe("readSecretInTerminal", () => {
  it("should return what was typed, show only the prompt, and give the terminal back", async () => {
    const stdin = fakeKeyboard();
    const stderr = textSink();

    const reading = readSecretInTerminal("Paste: ", { stdin, stderr: stderr.stream });
    stdin.type("sk-ant-oat01-abc\r");

    expect(await reading).toBe("sk-ant-oat01-abc");
    expect(stderr.text()).toBe("Paste: \n");
    expect(stdin.raw).toEqual([true, false]);
    expect(stdin.isPaused()).toBe(true);
    expect(stdin.listenerCount("keypress")).toBe(0);
  });

  it("should return null on Ctrl-C and give the terminal back", async () => {
    const stdin = fakeKeyboard();

    const reading = readSecretInTerminal("", { stdin, stderr: textSink().stream });
    stdin.type("abc\x03");

    expect(await reading).toBeNull();
    expect(stdin.raw).toEqual([true, false]);
  });

  it("should turn raw mode off, and rethrow, when the keyboard fails after raw mode went on, so a throw never leaves the terminal raw", async () => {
    const stdin = Object.assign(fakeKeyboard(), {
      resume(): never {
        throw new Error("no keyboard");
      },
    });

    await expect(readSecretInTerminal("", { stdin, stderr: textSink().stream })).rejects.toThrow("no keyboard");

    expect(stdin.raw).toEqual([true, false]);
  });
});
