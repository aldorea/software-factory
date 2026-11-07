import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isWebActionCommand, type WebActionEnd, type WebActionRecord } from "./web-action.ts";

const WEB_ACTION_ID = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z-[a-z]+(-[1-9][0-9]*)?$/;

export const ACTION_FILE = "action.json";
export const END_FILE = "end.json";
export const OUTPUT_FILE = "output.log";

export function parseWebActionId(candidate: string): string | null {
  return WEB_ACTION_ID.test(candidate) ? candidate : null;
}

export function webDir(repoDir: string): string {
  return join(repoDir, ".factory", "web");
}

export function webActionDir(repoDir: string, id: string): string {
  return join(webDir(repoDir), id);
}

export async function writeJsonFile(path: string, value: object): Promise<void> {
  const partial = `${path}.partial`;
  await writeFile(partial, `${JSON.stringify(value, null, 2)}\n`);
  await rename(partial, path);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function recordWebActionEnd(repoDir: string, id: string, end: WebActionEnd): Promise<void> {
  const dir = webActionDir(repoDir, id);
  if (!(await isDirectory(dir))) return;
  await writeJsonFile(join(dir, END_FILE), end);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is WebActionRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<WebActionRecord>;
  return (
    record.version === 1 &&
    typeof record.id === "string" &&
    isWebActionCommand(record.command) &&
    Array.isArray(record.args) &&
    record.args.every((arg) => typeof arg === "string") &&
    (record.issue === null || typeof record.issue === "number") &&
    typeof record.startedAt === "string" &&
    typeof record.pid === "number" &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    (record.processStart === null || typeof record.processStart === "string")
  );
}

function isEnd(value: unknown): value is WebActionEnd {
  if (typeof value !== "object" || value === null) return false;
  const end = value as Partial<WebActionEnd>;
  return typeof end.exitCode === "number" && typeof end.endedAt === "string";
}

export interface WebActionFiles {
  record: WebActionRecord;
  end: WebActionEnd | null;
}

export async function readWebAction(repoDir: string, id: string): Promise<WebActionFiles | null> {
  const dir = webActionDir(repoDir, id);
  const record = await readJson(join(dir, ACTION_FILE));
  if (!isRecord(record) || record.id !== id) return null;
  const end = await readJson(join(dir, END_FILE));
  return { record, end: isEnd(end) ? end : null };
}

export async function readWebActions(repoDir: string): Promise<WebActionFiles[]> {
  let names: string[];
  try {
    names = await readdir(webDir(repoDir));
  } catch {
    return [];
  }
  const ids = names.filter((name) => parseWebActionId(name) !== null).sort();
  const read = await Promise.all(ids.map((id) => readWebAction(repoDir, id)));
  return read.filter((files): files is WebActionFiles => files !== null);
}

export async function readOutput(repoDir: string, id: string): Promise<string> {
  try {
    return await readFile(join(webActionDir(repoDir, id), OUTPUT_FILE), "utf8");
  } catch {
    return "";
  }
}
