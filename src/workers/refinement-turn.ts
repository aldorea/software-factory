import { join } from "node:path";

export type AllowedTool =
  | { kind: "read"; path: string }
  | { kind: "edit"; path: string }
  | { kind: "command"; text: string; more: boolean };

export interface TurnPlace {
  issue: number;
  repoDir: string;
  worktree: string;
  factoryCli: string;
  pluginDir: string;
}

export interface TurnRequest {
  place: TurnPlace;
  session: string | null;
  model: string;
  allowedTools: readonly AllowedTool[];
}

export type TurnCommand =
  | { ok: true; args: string[]; env: Record<string, string>; readsAnswer: boolean }
  | { ok: false; problem: string };

export type TurnCheck = { kind: "waiting" } | { kind: "loaded"; session: string } | { kind: "refused"; problem: string };

export interface TurnChecker {
  onLine(line: string): TurnCheck;
}

export interface TurnMessage {
  kind: "text" | "tool" | "end";
  text: string;
}

export interface RefinementTurn {
  command(request: TurnRequest): TurnCommand;
  checker(): TurnChecker;
  transcript(lines: readonly string[]): TurnMessage[];
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function refinementTools(place: Pick<TurnPlace, "issue" | "repoDir" | "worktree">): AllowedTool[] {
  const issue = String(place.issue);
  return [
    { kind: "read", path: place.worktree },
    { kind: "edit", path: place.worktree },
    { kind: "edit", path: join(place.repoDir, ".factory", "holdout", issue) },
    { kind: "command", text: `gh issue view ${issue}`, more: true },
    { kind: "command", text: `gh issue edit ${issue}`, more: true },
    { kind: "command", text: `gh issue comment ${issue}`, more: true },
    { kind: "command", text: `git add specs/${issue}.md`, more: false },
    { kind: "command", text: "git commit", more: true },
    { kind: "command", text: `node "$FACTORY_CLI" validate ${issue}`, more: false },
  ];
}

export function describeTool(tool: AllowedTool): string {
  if (tool.kind !== "command") return `${tool.kind} ${tool.path}`;
  return `command ${tool.text}${tool.more ? " …" : ""}`;
}

function sameTool(a: AllowedTool, b: AllowedTool): boolean {
  if (a.kind === "command" || b.kind === "command") {
    return a.kind === "command" && b.kind === "command" && a.text === b.text && a.more === b.more;
  }
  return a.kind === b.kind && a.path === b.path;
}

export function turnRequestProblem(request: TurnRequest): string | null {
  const design = refinementTools(request.place);
  const foreign = request.allowedTools.filter((tool) => !design.some((allowed) => sameTool(allowed, tool)));
  if (foreign.length > 0) {
    return `the turn of the refinement allows only the tools of the design, and the list also holds: ${foreign.map(describeTool).join(", ")}`;
  }
  if (request.session !== null && !SESSION_ID.test(request.session)) {
    return "the session of the refinement is not a session ID; remove the conversation under .factory/web/ to start a new one";
  }
  if (request.model === "" || request.model.startsWith("-") || /\s/.test(request.model)) {
    return `${request.model} is not a model`;
  }
  return null;
}
