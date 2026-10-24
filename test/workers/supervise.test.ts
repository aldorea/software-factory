import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { supervise } from "../../src/workers/supervise.ts";

async function runNode(
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
  it("collects lines and the exit code", async () => {
    const { result, lines, log } = await runNode(`console.log("a"); console.log("b"); process.exit(3)`);
    expect(result).toMatchObject({ stopReason: "exited", exitCode: 3 });
    expect(lines).toEqual(["a", "b"]);
    expect(log).toBe("a\nb\n");
  });

  it("stops a silent process at the idle timeout", async () => {
    const { result } = await runNode(`setInterval(() => {}, 1000)`, { idleMs: 300 });
    expect(result.stopReason).toBe("idle-timeout");
  });

  it("stops a busy process at the deadline", async () => {
    const { result } = await runNode(`setInterval(() => console.log("tick"), 50)`, { deadlineMs: 400, idleMs: 5000 });
    expect(result.stopReason).toBe("deadline");
  });

  it("stops a process that hangs after its final line", async () => {
    const { result, lines } = await runNode(`console.log("done"); setInterval(() => {}, 1000)`, {
      finalLine: "done",
    });
    expect(result.stopReason).toBe("completion-grace");
    expect(lines).toEqual(["done"]);
  });

  it("writes a large stdin and closes it", async () => {
    const prompt = "x".repeat(300 * 1024);
    const { result, lines } = await runNode(
      `let n = 0; process.stdin.on("data", (c) => (n += c.length)); process.stdin.on("end", () => console.log(n))`,
      { stdin: prompt },
    );
    expect(result).toMatchObject({ stopReason: "exited", exitCode: 0 });
    expect(lines).toEqual([String(prompt.length)]);
  });

  it("closes stdin when there is no input, so a reader does not hang", async () => {
    const { result, lines } = await runNode(
      `process.stdin.resume(); process.stdin.on("end", () => console.log("eof"))`,
      { idleMs: 2000 },
    );
    expect(result.stopReason).toBe("exited");
    expect(lines).toEqual(["eof"]);
  });

  it("runs the process in the given directory, with PWD set to it", async () => {
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

  it("stops at the deadline a process whose child keeps the output open", async () => {
    const started = Date.now();
    const { result, lines } = await runNode(GRANDCHILD + `setInterval(() => {}, 1000)`, { deadlineMs: 400, idleMs: 5000 });
    expect(result.stopReason).toBe("deadline");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(isAlive(Number(lines[0]))).toBe(false);
  });

  it("returns when the process exits, even if its child keeps the output open", async () => {
    const started = Date.now();
    const { result, lines } = await runNode(GRANDCHILD + `process.exit(0)`, { idleMs: 5000 });
    expect(result).toMatchObject({ stopReason: "exited", exitCode: 0 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(isAlive(Number(lines[0]))).toBe(false);
  });

  it("keeps the tail of stderr", async () => {
    const { result } = await runNode(`console.error("broken"); process.exit(1)`);
    expect(result.stderrTail).toContain("broken");
  });
});
