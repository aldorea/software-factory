import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { webDir, writeJsonFile } from "../web/web-action-files.ts";
import { isAgentKind } from "../config/roles.ts";
import type { AgentKind } from "../workers/types.ts";

const SESSION_FILE = "session.json";
const TURNS_DIR = "turns";
const TURN_FILE = /^[0-9A-Za-z-]+\.jsonl$/;

export interface ConversationTurn {
  id: string;
  lines: string[];
}

export function conversationDir(repoDir: string, issue: number): string {
  return join(webDir(repoDir), `refinement-${issue}`);
}

export interface ConversationSession {
  session: string;
  agent: AgentKind;
}

export async function readConversationSession(repoDir: string, issue: number): Promise<ConversationSession | null> {
  try {
    const value = JSON.parse(await readFile(join(conversationDir(repoDir, issue), SESSION_FILE), "utf8")) as { session?: unknown; agent?: unknown };
    if (typeof value.session !== "string") return null;
    return { session: value.session, agent: typeof value.agent === "string" && isAgentKind(value.agent) ? value.agent : "claude-code" };
  } catch {
    return null;
  }
}

export async function readSession(repoDir: string, issue: number): Promise<string | null> {
  return (await readConversationSession(repoDir, issue))?.session ?? null;
}

export async function writeSession(repoDir: string, issue: number, recorded: ConversationSession): Promise<void> {
  await mkdir(conversationDir(repoDir, issue), { recursive: true });
  await writeJsonFile(join(conversationDir(repoDir, issue), SESSION_FILE), recorded);
}

export async function turnStreamPath(repoDir: string, issue: number, turnId: string): Promise<string> {
  const dir = join(conversationDir(repoDir, issue), TURNS_DIR);
  await mkdir(dir, { recursive: true });
  return join(dir, `${turnId}.jsonl`);
}

export async function readTurns(repoDir: string, issue: number): Promise<ConversationTurn[]> {
  const dir = join(conversationDir(repoDir, issue), TURNS_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = names.filter((name) => TURN_FILE.test(name)).sort();
  return Promise.all(
    files.map(async (name) => ({
      id: name.slice(0, -".jsonl".length),
      lines: (await readFile(join(dir, name), "utf8")).split("\n").filter((line) => line !== ""),
    })),
  );
}
