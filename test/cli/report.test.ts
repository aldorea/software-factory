import { describe, expect, it } from "vitest";
import { reportErr, reportFailure, reportOut } from "../../src/cli/report.ts";

const ESC = String.fromCharCode(27);

function sinks(options: { color?: boolean; errColor?: boolean }) {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, env: { ...options, out: (text: string) => out.push(text), err: (text: string) => err.push(text) } };
}

describe("report", () => {
  it("should colour a line written to stdout by the colour of stdout, not by the colour of stderr", () => {
    const { env, out } = sinks({ color: true, errColor: false });

    reportOut([{ kind: "ok", text: "done" }], env);

    expect(out[0]).toContain(`${ESC}[`);
  });

  it("should colour a line written to stderr by the colour of stderr, so a redirected stderr gets no codes and a terminal stderr gets them", () => {
    const redirectedStderr = sinks({ color: true, errColor: false });
    const terminalStderr = sinks({ color: false, errColor: true });

    reportErr([{ kind: "fail", text: "broken" }], redirectedStderr.env);
    reportErr([{ kind: "fail", text: "broken" }], terminalStderr.env);

    expect(redirectedStderr.err).toEqual(["✗ broken"]);
    expect(terminalStderr.err[0]).toContain(`${ESC}[`);
  });

  it("should draw plain text on both streams when no colour is set", () => {
    const { env, out, err } = sinks({});

    reportOut([{ kind: "ok", text: "a" }], env);
    reportErr([{ kind: "warn", text: "b" }], env);

    expect(out).toEqual(["✓ a"]);
    expect(err).toEqual(["⚠ b"]);
  });

  it("should tell whether it reported anything", () => {
    const { env } = sinks({});

    expect(reportErr([], env)).toBe(false);
    expect(reportErr([{ kind: "fail", text: "x" }], env)).toBe(true);
  });

  it("should write a failure with the factory prefix and its fix as the command", () => {
    const { env, err } = sinks({});

    reportFailure({ problem: "/c can be read by other users", fix: "chmod 600 /c" }, env);
    reportFailure({ problem: "no way" }, env);

    expect(err).toEqual(["✗ factory: /c can be read by other users → chmod 600 /c", "✗ factory: no way"]);
  });
});
