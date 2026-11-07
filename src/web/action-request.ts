import type { RoleChoice, RunRole } from "../config/config.ts";
import { choiceProblems, isAgentKind } from "../config/roles.ts";
import { RUN_ROLES, type ActionRequest } from "./action-args.ts";
import { WEB_ACTION_COMMANDS, type WebActionCommand } from "./web-action.ts";

export type ParsedActionRequest = { ok: true; request: ActionRequest } | { ok: false; problem: string };

const ISSUE_COMMANDS: ReadonlySet<WebActionCommand> = new Set(["run", "approve", "validate", "publish"]);

function refuse(problem: string): ParsedActionRequest {
  return { ok: false, problem };
}

function isCommand(value: unknown): value is WebActionCommand {
  return typeof value === "string" && (WEB_ACTION_COMMANDS as readonly string[]).includes(value);
}

function parseChoice(role: RunRole, value: unknown): { ok: true; choice: RoleChoice } | { ok: false; problem: string } {
  if (typeof value !== "object" || value === null) return { ok: false, problem: `the ${role} needs an agent and a model` };
  const { agent, model } = value as { agent?: unknown; model?: unknown };
  if (typeof agent !== "string" || !isAgentKind(agent)) return { ok: false, problem: `${String(agent)} is not an agent` };
  if (typeof model !== "string" || model.trim() === "" || /\s/.test(model)) {
    return { ok: false, problem: `the ${role} needs a model with no spaces` };
  }
  const choice = { agent, model };
  const problems = choiceProblems(role, choice);
  return problems.length > 0 ? { ok: false, problem: problems.join("; ") } : { ok: true, choice };
}

function parseRoles(value: unknown): { ok: true; roles: Partial<Record<RunRole, RoleChoice>> } | { ok: false; problem: string } {
  if (value === undefined) return { ok: true, roles: {} };
  if (typeof value !== "object" || value === null) return { ok: false, problem: "roles must be an object" };
  const roles: Partial<Record<RunRole, RoleChoice>> = {};
  for (const [role, choice] of Object.entries(value)) {
    const known = RUN_ROLES.find((candidate) => candidate === role);
    if (known === undefined) return { ok: false, problem: `${role} is not a role of a run` };
    const parsed = parseChoice(known, choice);
    if (!parsed.ok) return parsed;
    roles[known] = parsed.choice;
  }
  return { ok: true, roles };
}

export function parseActionRequest(body: string): ParsedActionRequest {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return refuse("the body is not JSON");
  }
  if (typeof value !== "object" || value === null) return refuse("the body is not an object");
  const { command, issue, roles } = value as { command?: unknown; issue?: unknown; roles?: unknown };
  if (!isCommand(command)) return refuse(`${String(command)} is not a web action: use one of ${WEB_ACTION_COMMANDS.join(", ")}`);
  if (!ISSUE_COMMANDS.has(command)) {
    if (issue !== undefined || roles !== undefined) return refuse(`factory ${command} takes no issue`);
    return { ok: true, request: { command: command as "doctor" | "image" | "init" } };
  }
  if (typeof issue !== "number" || !Number.isInteger(issue) || issue <= 0) return refuse(`factory ${command} needs the number of an issue`);
  if (command !== "run") {
    if (roles !== undefined) return refuse(`factory ${command} takes no roles`);
    return { ok: true, request: { command: command as "approve" | "validate" | "publish", issue } };
  }
  const parsed = parseRoles(roles);
  return parsed.ok ? { ok: true, request: { command, issue, roles: parsed.roles } } : refuse(parsed.problem);
}
