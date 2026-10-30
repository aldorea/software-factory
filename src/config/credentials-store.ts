import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentKind } from "../workers/types.ts";
import {
  CREDENTIAL_VARIABLES,
  parseCredentialsFile,
  removeCredentialLine,
  replaceCredentialLine,
  resolveCredentials,
  type Credentials,
  type SavedCredentials,
} from "./credentials.ts";

export type LoadedCredentials = { ok: true; credentials: Credentials; saved: Credentials } | { ok: false; problem: string };

export type SaveOutcome = { ok: true; path: string } | { ok: false; problem: string };

export async function readSavedCredentials(path: string): Promise<SavedCredentials> {
  let text: string;
  try {
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0) {
      return {
        ok: false,
        problem: `${path} can be read by other users (mode ${(info.mode & 0o777).toString(8)}); run chmod 600 ${path}`,
      };
    }
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, values: {} };
    throw error;
  }
  return parseCredentialsFile(text, path);
}

export async function loadCredentials(
  path: string,
  environment: Record<string, string | undefined>,
): Promise<LoadedCredentials> {
  const saved = await readSavedCredentials(path);
  if (!saved.ok) return saved;
  return { ok: true, credentials: resolveCredentials(environment, saved.values), saved: saved.values };
}

async function rewriteCredentials(path: string, change: (text: string) => string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(directory, `.credentials.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, change(text), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function saveCredential(path: string, agent: AgentKind, value: string): Promise<SaveOutcome> {
  const existing = await readSavedCredentials(path);
  if (!existing.ok) return existing;
  await rewriteCredentials(path, (text) => replaceCredentialLine(text, CREDENTIAL_VARIABLES[agent], value));
  return { ok: true, path };
}

export async function deleteCredential(path: string, agent: AgentKind): Promise<SaveOutcome> {
  const existing = await readSavedCredentials(path);
  if (!existing.ok) return existing;
  if (existing.values[agent] === undefined) return { ok: true, path };
  await rewriteCredentials(path, (text) => removeCredentialLine(text, CREDENTIAL_VARIABLES[agent]));
  return { ok: true, path };
}
