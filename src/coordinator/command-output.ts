import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExecResult } from "../workers/types.ts";
import { outputTail } from "./failures.ts";

export interface FailedOutput {
  outputTail?: string;
  outputLog?: string;
}

export async function keepFailedOutput(result: ExecResult, runDir: string, logPath: string): Promise<FailedOutput> {
  const output = result.stdout === "" || result.stdout.endsWith("\n") ? `${result.stdout}${result.stderr}` : `${result.stdout}\n${result.stderr}`;
  const tail = outputTail(output);
  if (tail === undefined) return {};
  const file = join(runDir, logPath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, output);
  return { outputTail: tail, outputLog: logPath };
}

export function checkLogPath(label: string, index: number, name: string): string {
  return join("output", label, `check-${index + 1}-${name.replace(/[^A-Za-z0-9._-]+/g, "-")}.log`);
}

export function criterionLogPath(label: string, id: string): string {
  return join("output", label, `${id}.log`);
}
