import type { RoleChoice, RunRole } from "../config/config.ts";
import { ROLE_FLAGS } from "../config/role-flags.ts";

export const RUN_ROLES: readonly RunRole[] = ["workers", "verifier", "tester"];

export type ActionRequest =
  | { command: "run"; issue: number; roles: Partial<Record<RunRole, RoleChoice>> }
  | { command: "approve" | "validate" | "publish"; issue: number }
  | { command: "doctor" | "image" | "init" };

export function actionArgs(request: ActionRequest): string[] {
  if (!("issue" in request)) return [request.command];
  if (request.command !== "run") return [request.command, String(request.issue)];
  return [
    request.command,
    String(request.issue),
    ...RUN_ROLES.flatMap((role) => {
      const choice = request.roles[role];
      return choice === undefined ? [] : [ROLE_FLAGS[role], `${choice.agent}:${choice.model}`];
    }),
  ];
}

export function commandText(args: readonly string[]): string {
  return ["factory", ...args].join(" ");
}

export function actionIssue(request: ActionRequest): number | null {
  return "issue" in request ? request.issue : null;
}
