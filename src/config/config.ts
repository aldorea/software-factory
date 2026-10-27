import type { Role } from "../workers/agent-adapter.ts";
import { AGENT_KINDS } from "../workers/agents.ts";
import type { AgentKind } from "../workers/types.ts";
import { choiceProblems, isAgentKind, ROLES } from "./roles.ts";

export type { AgentKind, Role };

export interface Check {
  name: string;
  command: string;
}

export interface AppConfig {
  start: string;
  ready?: string;
  readyTimeoutMs?: number;
}

export interface AppStart {
  start: string;
  ready?: string;
  readyTimeoutMs: number;
}

export const DEFAULT_READY_TIMEOUT_MS = 60_000;

export interface EvidenceCommands {
  playwright?: string;
  request?: string;
  attachments?: string;
}

export const ID_PLACEHOLDER = "{{id}}";

export type EnvironmentPurpose = "worker" | "gate" | "verification" | "tester";

export interface WorkerEnvironmentContext {
  purpose: EnvironmentPurpose;
  subtask: string | null;
  slot: number;
}

export interface RoleChoice {
  agent: AgentKind;
  model: string;
}

export interface AgentLimits {
  maxParallel: number;
  maxParallelCeiling: number;
  tokensPerSubtask: number;
  tokensPerRun: number;
}

export interface RunLimits {
  patience: number;
  subtaskWallClockMs: number;
  runWallClockMs: number;
  attemptIdleTimeoutMs: number;
}

export interface FactoryConfig {
  image: string;
  checks: Check[];
  app?: AppConfig;
  evidence?: EvidenceCommands;
  environment: (worker: WorkerEnvironmentContext) => Record<string, string>;
  protectedPaths: string[];
  roles?: Partial<Record<Role, RoleChoice>>;
  agents?: Partial<Record<AgentKind, Partial<AgentLimits>>>;
  limits?: Partial<RunLimits>;
}

export interface ResolvedConfig {
  image: string;
  checks: Check[];
  app?: AppStart;
  evidence: EvidenceCommands;
  environment: (worker: WorkerEnvironmentContext) => Record<string, string>;
  protectedPaths: string[];
  roles: Partial<Record<Role, RoleChoice>>;
  agents: Record<AgentKind, AgentLimits>;
  limits: RunLimits;
}

const HOUR_MS = 60 * 60 * 1000;

export const DEFAULT_LIMITS: { agents: Record<AgentKind, AgentLimits>; run: RunLimits } = {
  agents: {
    "claude-code": { maxParallel: 1, maxParallelCeiling: 2, tokensPerSubtask: 2_000_000, tokensPerRun: 8_000_000 },
    opencode: { maxParallel: 1, maxParallelCeiling: 2, tokensPerSubtask: 2_000_000, tokensPerRun: 8_000_000 },
  },
  run: { patience: 3, subtaskWallClockMs: 2 * HOUR_MS, runWallClockMs: 6 * HOUR_MS, attemptIdleTimeoutMs: HOUR_MS / 6 },
};

export type ConfigResult = { ok: true; config: ResolvedConfig } | { ok: false; problems: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function resolveConfig(value: unknown): ConfigResult {
  if (!isRecord(value)) return { ok: false, problems: ["the default export must be an object"] };
  const problems: string[] = [];

  if (!isNonEmptyString(value.image)) problems.push("image must be a non-empty string");

  const checks = readChecks(value.checks, problems);

  const app = readApp(value.app, problems);

  const evidence = readEvidence(value.evidence, problems);

  if (typeof value.environment !== "function") {
    problems.push("environment must be a function from the worker to its environment");
  }

  const protectedPaths = value.protectedPaths;
  if (!Array.isArray(protectedPaths) || !protectedPaths.every((path) => typeof path === "string")) {
    problems.push("protectedPaths must be a list of strings");
  }

  const roles = readRoles(value.roles, problems);
  const agents = readAgents(value.agents, problems);
  const limits = readNumbers(value.limits, "limits", DEFAULT_LIMITS.run, problems);

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    config: {
      image: value.image as string,
      checks,
      ...(app ? { app } : {}),
      evidence,
      environment: value.environment as ResolvedConfig["environment"],
      protectedPaths: protectedPaths as string[],
      roles,
      agents,
      limits,
    },
  };
}

function readChecks(value: unknown, problems: string[]): Check[] {
  if (!Array.isArray(value) || value.length === 0) {
    problems.push("checks must list at least one check");
    return [];
  }
  return value.flatMap((check, index) => {
    if (isRecord(check) && isNonEmptyString(check.name) && isNonEmptyString(check.command)) {
      return [{ name: check.name, command: check.command }];
    }
    problems.push(`checks[${index}] must have a non-empty name and command`);
    return [];
  });
}

function readApp(value: unknown, problems: string[]): AppStart | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !isNonEmptyString(value.start)) {
    problems.push("app.start must be a non-empty string");
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!["start", "ready", "readyTimeoutMs"].includes(key)) problems.push(`app.${key} is not a known setting`);
  }
  const app: AppStart = { start: value.start, readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS };
  if (value.ready !== undefined) {
    if (isNonEmptyString(value.ready)) app.ready = value.ready;
    else problems.push("app.ready must be a non-empty command that exits zero once the app serves");
  }
  if (value.readyTimeoutMs !== undefined) {
    const timeout = value.readyTimeoutMs;
    if (typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0) app.readyTimeoutMs = timeout;
    else problems.push("app.readyTimeoutMs must be a positive number");
  }
  return app;
}

function readEvidence(value: unknown, problems: string[]): EvidenceCommands {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    problems.push("evidence must be an object with the e2e and request commands");
    return {};
  }
  const evidence: EvidenceCommands = {};
  for (const key of Object.keys(value)) {
    if (!["playwright", "request", "attachments"].includes(key)) problems.push(`evidence.${key} is not a known setting`);
  }
  for (const kind of ["playwright", "request"] as const) {
    const command = value[kind];
    if (command === undefined) continue;
    if (!isNonEmptyString(command) || !command.includes(ID_PLACEHOLDER)) {
      problems.push(`evidence.${kind} must be a command with the ${ID_PLACEHOLDER} placeholder for the criterion ID`);
    } else evidence[kind] = command;
  }
  if (value.attachments !== undefined) {
    const attachments = value.attachments;
    if (!isNonEmptyString(attachments) || attachments.startsWith("/") || attachments.split("/").includes("..")) {
      problems.push("evidence.attachments must be a folder inside the repo, as a relative path");
    } else evidence.attachments = attachments;
  }
  return evidence;
}

function readRoles(value: unknown, problems: string[]): Partial<Record<Role, RoleChoice>> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    problems.push("roles must give the default agent and model of the workers, the verifier and the tester");
    return {};
  }
  const roles: Partial<Record<Role, RoleChoice>> = {};
  for (const key of Object.keys(value)) {
    if (!(ROLES as string[]).includes(key)) problems.push(`roles.${key} is not a role`);
  }
  for (const role of ROLES) {
    const choice = value[role];
    if (choice === undefined) continue;
    if (!isRecord(choice)) {
      problems.push(`roles.${role} must be an object with agent and model`);
      continue;
    }
    const { agent, model } = choice;
    if (typeof agent !== "string" || !isAgentKind(agent)) {
      problems.push(`roles.${role}.agent must be one of ${AGENT_KINDS.join(", ")}`);
      continue;
    }
    if (!isNonEmptyString(model)) {
      problems.push(`roles.${role}.model must be a non-empty string`);
      continue;
    }
    const invalid = choiceProblems(role, { agent, model });
    if (invalid.length > 0) {
      problems.push(...invalid.map((problem) => `roles.${role}: ${problem}`));
      continue;
    }
    roles[role] = { agent, model };
  }
  return roles;
}

function readAgents(value: unknown, problems: string[]): Record<AgentKind, AgentLimits> {
  if (value !== undefined && !isRecord(value)) problems.push("agents must be an object from agent to its limits");
  const given = isRecord(value) ? value : {};
  for (const key of Object.keys(given)) {
    if (!(AGENT_KINDS as string[]).includes(key)) problems.push(`agents.${key} is not an agent`);
  }
  const agents = {} as Record<AgentKind, AgentLimits>;
  for (const kind of AGENT_KINDS) {
    agents[kind] = readNumbers(given[kind], `agents.${kind}`, DEFAULT_LIMITS.agents[kind], problems);
  }
  return agents;
}

function readNumbers<T extends object>(value: unknown, where: string, defaults: T, problems: string[]): T {
  if (value === undefined) return { ...defaults };
  if (!isRecord(value)) {
    problems.push(`${where} must be an object`);
    return { ...defaults };
  }
  const result: Record<string, number> = { ...(defaults as Record<string, number>) };
  for (const [key, given] of Object.entries(value)) {
    if (!(key in defaults)) problems.push(`${where}.${key} is not a known setting`);
    else if (typeof given !== "number" || !Number.isFinite(given) || given <= 0) {
      problems.push(`${where}.${key} must be a positive number`);
    } else result[key] = given;
  }
  return result as T;
}
