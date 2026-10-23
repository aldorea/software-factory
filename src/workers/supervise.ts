import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type StopReason = "exited" | "idle-timeout" | "deadline" | "completion-grace";

export interface SupervisedRun {
  stopReason: StopReason;
  exitCode: number | null;
  stderrTail: string;
}

export interface SuperviseOptions {
  command: string;
  args: string[];
  logPath: string;
  deadline: Date;
  idleTimeoutMs: number;
  onLine: (line: string) => void;
  terminate?: () => Promise<void>;
  graceMs?: number;
  isFinalLine?: (line: string) => boolean;
  completionGraceMs?: number;
}

const STDERR_TAIL_BYTES = 4000;

export async function supervise(options: SuperviseOptions): Promise<SupervisedRun> {
  await mkdir(dirname(options.logPath), { recursive: true });
  const log = createWriteStream(options.logPath, { flags: "a" });
  const child = spawn(options.command, options.args, { stdio: ["ignore", "pipe", "pipe"] });

  let stopReason: StopReason = "exited";
  let buffer = "";
  let stderrTail = "";
  let idleTimer: NodeJS.Timeout | undefined;
  let completionTimer: NodeJS.Timeout | undefined;
  let stopping = false;

  const stop = async (reason: StopReason) => {
    if (stopping) return;
    stopping = true;
    stopReason = reason;
    if (options.terminate) {
      await options.terminate().catch(() => undefined);
    }
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), options.graceMs ?? 2000).unref();
  };

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void stop("idle-timeout"), options.idleTimeoutMs);
  };

  const msToDeadline = Math.max(0, options.deadline.getTime() - Date.now());
  const deadlineTimer = setTimeout(() => void stop("deadline"), msToDeadline);
  resetIdle();

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    resetIdle();
    log.write(chunk);
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim() !== "") {
        options.onLine(line);
        if (!completionTimer && options.isFinalLine?.(line)) {
          completionTimer = setTimeout(
            () => void stop("completion-grace"),
            options.completionGraceMs ?? 30_000,
          );
        }
      }
      newline = buffer.indexOf("\n");
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    resetIdle();
    log.write(chunk);
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  }).finally(() => {
    clearTimeout(deadlineTimer);
    if (idleTimer) clearTimeout(idleTimer);
    if (completionTimer) clearTimeout(completionTimer);
  });

  if (buffer.trim() !== "") options.onLine(buffer);
  await new Promise<void>((resolve) => log.end(resolve));

  return { stopReason, exitCode, stderrTail };
}
