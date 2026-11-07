import { planLimitAnnotate } from "../cli/plan-limit-warning.ts";
import { menuEntries, ROLE_LABELS, SUGGESTED_MODELS, type RoleOrigin } from "../cli/role-menu.ts";
import type { RoleChoice, RunRole } from "../config/config.ts";
import { ROLE_FLAGS } from "../config/roles.ts";
import { defaultOrigin, resumeDefaults } from "../coordinator/resume.ts";
import type { RunLog } from "../coordinator/run-log.ts";
import type { AgentKind } from "../workers/types.ts";
import { RUN_ROLES } from "./action-args.ts";

export interface RunFormRole {
  role: RunRole;
  label: string;
  flag: string;
  offered: AgentKind[];
  models: Partial<Record<AgentKind, string[]>>;
  choice: RoleChoice | null;
  origin: RoleOrigin | null;
  warning: string | null;
}

export interface RunForm {
  issue: number;
  roles: RunFormRole[];
  problem: string | null;
}

export interface RunFormInput {
  issue: number;
  previous: RunLog | null;
  configured: Partial<Record<RunRole, RoleChoice>>;
  problem: string | null;
  now: Date;
}

export function runForm({ issue, previous, configured, problem, now }: RunFormInput): RunForm {
  const entries = menuEntries({
    roles: [...RUN_ROLES],
    flagged: {},
    defaults: resumeDefaults(previous, configured),
    defaultOrigin: (role) => defaultOrigin(previous, role),
  });
  const warnings = planLimitAnnotate(previous, now)(entries);
  return {
    issue,
    problem,
    roles: entries.map((entry) => {
      const role = entry.role as RunRole;
      return {
        role,
        label: ROLE_LABELS[role],
        flag: ROLE_FLAGS[role],
        offered: entry.offered,
        models: Object.fromEntries(entry.offered.map((agent) => [agent, SUGGESTED_MODELS[agent]])),
        choice: entry.choice ?? null,
        origin: entry.origin ?? null,
        warning: warnings[role]?.join(" ") ?? null,
      };
    }),
  };
}
