import { problemOf, type CredentialsProblem } from "../config/credentials.ts";
import type { CliEnv } from "./main.ts";
import { renderSetup, type SetupLine } from "./setup-render.ts";

export type Reporter = Pick<CliEnv, "out" | "err" | "color" | "errColor">;

export function reportOut(lines: SetupLine[], env: Reporter): void {
  for (const line of renderSetup(lines, env.color === true)) env.out(line);
}

export function reportErr(lines: SetupLine[], env: Reporter): boolean {
  for (const line of renderSetup(lines, env.errColor === true)) env.err(line);
  return lines.length > 0;
}

export function failureLine(failure: CredentialsProblem, prefix = "factory: "): SetupLine {
  const { problem, fix } = problemOf(failure);
  return { kind: "fail", text: `${prefix}${problem}`, ...(fix !== undefined ? { command: fix } : {}) };
}

export function reportFailure(failure: CredentialsProblem, env: Reporter): void {
  reportErr([failureLine(failure)], env);
}
