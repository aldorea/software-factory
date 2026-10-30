import { describe, expect, it } from "vitest";
import { hidesSecret, terminalFeatures } from "../../src/cli/tty.ts";

describe("terminal features", () => {
  it("should draw colours and the bottom line whenever stdout is a terminal, also when stdin is piped", () => {
    expect(terminalFeatures({ stdout: true, stdin: false })).toEqual({ screen: true, menu: false });
  });

  it("should offer the role menu only when stdin and stdout are both terminals, because the menu reads keys", () => {
    expect(terminalFeatures({ stdout: true, stdin: true })).toEqual({ screen: true, menu: true });
    expect(terminalFeatures({ stdout: false, stdin: true })).toEqual({ screen: false, menu: false });
  });

  it("should draw nothing when stdout is not a terminal, so a redirected output stays plain text", () => {
    expect(terminalFeatures({ stdout: false, stdin: false })).toEqual({ screen: false, menu: false });
  });
});

describe("hidden secret input", () => {
  it("should hide what is typed whenever stdin is a terminal, also when stdout is redirected, so factory auth > file never echoes the secret", () => {
    expect(hidesSecret({ stdin: true })).toBe(true);
  });

  it("should read a plain line when stdin is piped, because there is no keyboard to hide", () => {
    expect(hidesSecret({ stdin: false })).toBe(false);
  });
});
