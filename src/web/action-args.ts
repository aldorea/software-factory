import type { RoleChoice, RunRole } from "../config/config.ts";
import { ROLE_FLAGS } from "../config/role-flags.ts";
import type { AgentKind } from "../workers/types.ts";

export const RUN_ROLES: readonly RunRole[] = ["workers", "verifier", "tester"];

export type ActionRequest =
  | { command: "run"; issue: number; roles: Partial<Record<RunRole, RoleChoice>> }
  | { command: "approve" | "validate" | "publish"; issue: number }
  | { command: "doctor" | "image" | "init" }
  | { command: "auth"; agent: AgentKind; credential: string; force: boolean }
  | { command: "refine"; issue: number; agent: RoleChoice | null; answer: string };

export function actionArgs(request: ActionRequest): string[] {
  if (request.command === "auth") return ["auth", request.agent, ...(request.force ? ["--force"] : [])];
  if (request.command === "refine") {
    const agent = request.agent === null ? [] : [ROLE_FLAGS.refinement, `${request.agent.agent}:${request.agent.model}`];
    return ["refine", String(request.issue), "--turn", ...agent];
  }
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

export function actionStdin(request: ActionRequest): string | null {
  if (request.command === "auth") return `${request.credential}\n`;
  if (request.command === "refine" && request.answer !== "") return request.answer;
  return null;
}

export function actionIssue(request: ActionRequest): number | null {
  return "issue" in request ? request.issue : null;
}
