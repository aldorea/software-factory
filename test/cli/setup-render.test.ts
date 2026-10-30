import { describe, expect, it } from "vitest";
import { colorEnabled, renderSetup, type SetupLine } from "../../src/cli/setup-render.ts";

const ESC = String.fromCharCode(27);
const ansi = /\u001b\[[0-9;]*[A-Za-z]/;
const RESET = `${ESC}[0m`;
const bold = (code: number, text: string) => `${ESC}[1;${code}m${text}${RESET}`;

const lines: SetupLine[] = [
  { kind: "title", text: "Next:" },
  { kind: "ok", text: "wrote .factory/config.ts" },
  { kind: "warn", text: "token does not start with sk-ant-oat" },
  { kind: "fail", text: "origin/HEAD not set", command: "git remote set-head origin --auto" },
  { kind: "text", text: "  2. ", command: "factory auth" },
  { kind: "text", text: "plain" },
];

describe("setup rendering", () => {
  it("should print every line type as plain text, with its mark and the command after an arrow, when colour is off", () => {
    expect(renderSetup(lines, false)).toEqual([
      "Next:",
      "✓ wrote .factory/config.ts",
      "⚠ token does not start with sk-ant-oat",
      "✗ origin/HEAD not set → git remote set-head origin --auto",
      "  2. factory auth",
      "plain",
    ]);
  });

  it("should print no ANSI code at all when colour is off", () => {
    expect(renderSetup(lines, false).join("\n")).not.toMatch(ansi);
  });

  it("should paint the mark of a done step in bold bright green", () => {
    expect(renderSetup([{ kind: "ok", text: "wrote a" }], true)).toEqual([`${bold(92, "✓")} wrote a`]);
  });

  it("should paint the mark of a problem in bold bright red", () => {
    expect(renderSetup([{ kind: "fail", text: "broken" }], true)).toEqual([`${bold(91, "✗")} broken`]);
  });

  it("should paint the mark of a warning in bold bright yellow", () => {
    expect(renderSetup([{ kind: "warn", text: "careful" }], true)).toEqual([`${bold(93, "⚠")} careful`]);
  });

  it("should paint the command after the arrow in bold bright cyan and leave the arrow plain", () => {
    expect(renderSetup([{ kind: "fail", text: "no token", command: "factory auth" }], true)).toEqual([
      `${bold(91, "✗")} no token → ${bold(96, "factory auth")}`,
    ]);
  });

  it("should paint the command of a text line in bold bright cyan right after its text", () => {
    expect(renderSetup([{ kind: "text", text: "  2. ", command: "factory auth" }], true)).toEqual([
      `  2. ${bold(96, "factory auth")}`,
    ]);
  });

  it("should print the note of a text line after its command, in plain text", () => {
    expect(renderSetup([{ kind: "text", text: "  2. ", command: "factory auth", note: "   set it" }], true)).toEqual([
      `  2. ${bold(96, "factory auth")}   set it`,
    ]);
  });

  it("should print a title in bold", () => {
    expect(renderSetup([{ kind: "title", text: "Next:" }], true)).toEqual([`${ESC}[1mNext:${RESET}`]);
  });

  it("should leave a plain text line without any code", () => {
    expect(renderSetup([{ kind: "text", text: "plain" }], true)).toEqual(["plain"]);
  });
});

describe("colour decision", () => {
  it("should use colour when stdout is a terminal and NO_COLOR is not set", () => {
    expect(colorEnabled({ stdout: true, noColor: undefined })).toBe(true);
  });

  it("should use no colour when stdout is not a terminal, so a redirected output stays plain text", () => {
    expect(colorEnabled({ stdout: false, noColor: undefined })).toBe(false);
  });

  it("should use no colour when NO_COLOR is set to any non-empty value, even in a terminal", () => {
    expect(colorEnabled({ stdout: true, noColor: "1" })).toBe(false);
  });

  it("should ignore an empty NO_COLOR, as no-color.org asks", () => {
    expect(colorEnabled({ stdout: true, noColor: "" })).toBe(true);
  });
});
