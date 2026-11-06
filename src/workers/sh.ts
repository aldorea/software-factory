import { execFile, spawn } from "node:child_process";
import type { ExecResult } from "./types.ts";

const STOP_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const liveGroups = new Set<number>();

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    return;
  }
}

function killLiveGroups(): void {
  for (const pid of liveGroups) killGroup(pid);
  liveGroups.clear();
  unwatchStop();
}

function stopOn(signal: NodeJS.Signals): void {
  killLiveGroups();
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

const stopHandlers = new Map(STOP_SIGNALS.map((signal) => [signal, () => stopOn(signal)] as const));

function watchStop(): void {
  process.on("exit", killLiveGroups);
  for (const [signal, handler] of stopHandlers) process.once(signal, handler);
}

function unwatchStop(): void {
  process.off("exit", killLiveGroups);
  for (const [signal, handler] of stopHandlers) process.off(signal, handler);
}

function track(pid: number): void {
  if (liveGroups.size === 0) watchStop();
  liveGroups.add(pid);
}

function untrack(pid: number): void {
  if (!liveGroups.delete(pid)) return;
  if (liveGroups.size === 0) unwatchStop();
}

export class ExecTimeoutError extends Error {
  readonly killed = true;

  constructor(command: string, args: string[], timeoutMs: number) {
    super(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`);
  }
}

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function execEnv(env: Record<string, string> | undefined): NodeJS.ProcessEnv | undefined {
  return env ? { ...process.env, ...env } : undefined;
}

export function exec(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? 0;
  if (timeoutMs > 0) return execInOwnGroup(command, args, { ...options, timeoutMs });
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd: options.cwd, maxBuffer: MAX_OUTPUT_BYTES, env: execEnv(options.env) },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ exitCode: error ? Number(error.code) : 0, stdout, stderr });
      },
    );
  });
}

function execInOwnGroup(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number; env?: Record<string, string> },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: execEnv(options.env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const pid = child.pid;
    let failure: Error | undefined;
    let size = 0;
    const output = { stdout: "", stderr: "" };
    const stop = (error: Error) => {
      failure ??= error;
      if (pid !== undefined) killGroup(pid);
    };
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream].setEncoding("utf8");
      child[stream].on("data", (chunk: string) => {
        size += Buffer.byteLength(chunk);
        if (size > MAX_OUTPUT_BYTES) {
          stop(new Error(`${command} ${args.join(" ")} wrote more than ${MAX_OUTPUT_BYTES} bytes`));
          return;
        }
        output[stream] += chunk;
      });
    }
    const timer = setTimeout(() => stop(new ExecTimeoutError(command, args, options.timeoutMs)), options.timeoutMs);
    if (pid !== undefined) track(pid);
    const settle = () => {
      clearTimeout(timer);
      if (pid !== undefined) untrack(pid);
    };
    child.on("error", (error) => {
      settle();
      reject(error);
    });
    child.on("close", (code, signal) => {
      settle();
      if (failure !== undefined) reject(failure);
      else if (code === null) reject(new Error(`${command} ${args.join(" ")} was stopped by ${signal ?? "a signal"}`));
      else resolve({ exitCode: code, ...output });
    });
  });
}

export async function execOk(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<string> {
  const result = await exec(command, args, options);
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}
