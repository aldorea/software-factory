import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { supervise } from "../../src/workers/supervise.ts";

async function superviseNode(
  script: string,
  options: { deadlineMs?: number; idleMs?: number; finalLine?: string; stdin?: string } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "supervise-"));
  const logPath = join(dir, "attempt.jsonl");
  const lines: string[] = [];
  const result = await supervise({
    command: process.execPath,
    args: ["-e", script],
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    logPath,
    deadline: new Date(Date.now() + (options.deadlineMs ?? 10_000)),
    idleTimeoutMs: options.idleMs ?? 10_000,
    onLine: (line) => lines.push(line),
    ...(options.finalLine ? { isFinalLine: (line: string) => line === options.finalLine } : {}),
    completionGraceMs: 200,
    graceMs: 200,
  });
  return { result, lines, log: await readFile(logPath, "utf8") };
}

const GRANDCHILD = `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); console.log(c.pid);`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("supervise", () => {
  it("should collect lines and the exit code", async () => {
    const { result, lines, log } = await superviseNode(`console.log("a"); console.log("b"); process.exit(3)`);
    expect(result).toMatchObject({ stopReason: "exited", exitCode: 3 });
    expect(lines).toEqual(["a", "b"]);
    expect(log).toBe("a\nb\n");
  });

  it("should stop a silent process at the idle timeout", async () => {
    const { result } = await superviseNode(`setInterval(() => {}, 1000)`, { idleMs: 300 });
    expect(result.stopReason).toBe("idle-timeout");
  });

  it("should stop a busy process at the deadline", async () => {
    const { result } = await superviseNode(`setInterval(() => console.log("tick"), 50)`, { deadlineMs: 400, idleMs: 5000 });
    expect(result.stopReason).toBe("deadline");
  });

  it("should stop a process that hangs after its final line", async () => {
    const { result, lines } = await superviseNode(`console.log("done"); setInterval(() => {}, 1000)`, {
      finalLine: "done",
    });
    expect(result.stopReason).toBe("completion-grace");
    expect(lines).toEqual(["done"]);
  });

  it("should write a large stdin and close it", async () => {
    const prompt = "x".repeat(300 * 1024);
    const { result, lines } = await superviseNode(
      `let n = 0; process.stdin.on("data", (c) => (n += c.length)); process.stdin.on("end", () => console.log(n))`,
      { stdin: prompt },
    );
    expect(result).toMatchObject({ stopReason: "exited", exitCode: 0 });
    expect(lines).toEqual([String(prompt.length)]);
  });

  it("should close stdin when there is no input, so a reader does not hang", async () => {
    const { result, lines } = await superviseNode(
      `process.stdin.resume(); process.stdin.on("end", () => console.log("eof"))`,
      { idleMs: 2000 },
    );
    expect(result.stopReason).toBe("exited");
    expect(lines).toEqual(["eof"]);
  });

  it("should run the process in the given directory, with PWD set to it", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "supervise-cwd-")));
    const lines: string[] = [];
    await supervise({
      command: process.execPath,
      args: ["-e", "console.log(process.cwd()); console.log(process.env.PWD)"],
      cwd: dir,
      logPath: join(dir, "log"),
      deadline: new Date(Date.now() + 10_000),
      idleTimeoutMs: 10_000,
      onLine: (line) => lines.push(line),
    });
    expect(lines).toEqual([dir, dir]);
  });

  it("should stop at the deadline a process whose child keeps the output open", async () => {
    const started = Date.now();
    const { result, lines } = await superviseNode(GRANDCHILD + `setInterval(() => {}, 1000)`, { deadlineMs: 400, idleMs: 5000 });
    expect(result.stopReason).toBe("deadline");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(isAlive(Number(lines[0]))).toBe(false);
  });

  it("should return when the process exits, even if its child keeps the output open", async () => {
    const started = Date.now();
    const { result, lines } = await superviseNode(GRANDCHILD + `process.exit(0)`, { idleMs: 5000 });
    expect(result).toMatchObject({ stopReason: "exited", exitCode: 0 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(isAlive(Number(lines[0]))).toBe(false);
  });

  it("should keep the tail of stderr", async () => {
    const { result } = await superviseNode(`console.error("broken"); process.exit(1)`);
    expect(result.stderrTail).toContain("broken");
  });
});
