import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { TurnCheck, TurnChecker } from "../workers/refinement-turn.ts";

export interface TurnProcess {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  answer: string;
  streamPath: string;
  checker: TurnChecker;
  onLoaded(session: string): Promise<void>;
  onStderr(line: string): void;
}

export type TurnEnd = { kind: "refused"; problem: string } | { kind: "ended"; exitCode: number };

const NOT_REPORTED = "the agent of the refinement did not report its tools, so the allowed tools cannot be checked";

export async function runTurnProcess(turn: TurnProcess): Promise<TurnEnd> {
  const stream = await open(turn.streamPath, "a");
  try {
    const child = spawn(turn.command, turn.args, {
      cwd: turn.cwd,
      env: { ...process.env, ...turn.env },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(turn.answer);
    createInterface({ input: child.stderr }).on("line", turn.onStderr);
    const state: { check: TurnCheck } = { check: { kind: "waiting" } };
    let writes = Promise.resolve();
    const lines = createInterface({ input: child.stdout });
    const read = new Promise<void>((resolve) => lines.once("close", () => resolve()));
    lines.on("line", (line) => {
      if (state.check.kind === "refused") return;
      writes = writes.then(() => stream.write(`${line}\n`).then(() => undefined));
      const next = turn.checker.onLine(line);
      if (next.kind === "loaded" && state.check.kind === "waiting") writes = writes.then(() => turn.onLoaded(next.session));
      if (next.kind === "refused") {
        child.kill("SIGKILL");
        lines.close();
      }
      state.check = next;
    });
    const current = (): TurnCheck => state.check;
    const exitCode = await exited;
    if (current().kind !== "refused") await read;
    await writes;
    const check = current();
    if (check.kind === "refused") return { kind: "refused", problem: check.problem };
    if (check.kind === "waiting") return { kind: "refused", problem: NOT_REPORTED };
    return { kind: "ended", exitCode: exitCode ?? 1 };
  } finally {
    await stream.close();
  }
}
