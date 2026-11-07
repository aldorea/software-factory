import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { processStartTime } from "./process-start.ts";
import { ACTION_FILE, OUTPUT_FILE, webActionDir, webDir, writeJsonFile } from "./web-action-files.ts";
import type { WebActionRecord } from "./web-action.ts";

export interface WebActionStart {
  id: string;
  command: string;
  args: string[];
  issue: number | null;
}

export interface LaunchInput {
  repoDir: string;
  factoryBin: string;
  start: WebActionStart;
  now: Date;
}

function spawned(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => {
      child.off("error", reject);
      if (child.pid === undefined) reject(new Error("the web action started with no process ID"));
      else resolve(child.pid);
    });
  });
}

export async function launchWebAction({ repoDir, factoryBin, start, now }: LaunchInput): Promise<WebActionRecord> {
  await mkdir(webDir(repoDir), { recursive: true });
  const dir = webActionDir(repoDir, start.id);
  await mkdir(dir);
  const output = await open(join(dir, OUTPUT_FILE), "a");
  let pid: number;
  try {
    const child = spawn(process.execPath, [factoryBin, ...start.args, "--web-action", start.id], {
      cwd: repoDir,
      detached: true,
      shell: false,
      stdio: ["ignore", output.fd, output.fd],
    });
    pid = await spawned(child);
    child.unref();
  } finally {
    await output.close();
  }
  const record: WebActionRecord = {
    version: 1,
    id: start.id,
    command: start.command,
    args: start.args,
    issue: start.issue,
    startedAt: now.toISOString(),
    pid,
    processStart: await processStartTime(pid),
  };
  await writeJsonFile(join(dir, ACTION_FILE), record);
  return record;
}

export async function stopWebAction(record: Pick<WebActionRecord, "pid" | "processStart">): Promise<boolean> {
  if (record.processStart === null || (await processStartTime(record.pid)) !== record.processStart) return false;
  try {
    process.kill(-record.pid, "SIGINT");
    return true;
  } catch {
    return false;
  }
}
