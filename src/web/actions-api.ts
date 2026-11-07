import { access } from "node:fs/promises";
import { join } from "node:path";
import { clockMinutes } from "../cli/clock-time.ts";
import { runInProgressRefusal } from "../cli/run-in-progress.ts";
import type { RoleChoice, RunRole } from "../config/config.ts";
import { configPath, loadConfig } from "../config/load.ts";
import { latestRunEntry } from "../coordinator/run-history.ts";
import { actionArgs, actionIssue, actionStdin, type ActionRequest } from "./action-args.ts";
import { parseActionRequest } from "./action-request.ts";
import type { WebRequest, WebResponse } from "./handler.ts";
import type { WebActionStart } from "./launcher.ts";
import { refinementConversation } from "./refinement-api.ts";
import { runForm } from "./run-form.ts";
import { readOutput, readWebAction, readWebActions, type WebActionFiles } from "./web-action-files.ts";
import { webActionView, type WebActionView } from "./web-action-view.ts";
import { NOTHING_TO_STOP, refineTurnInProgress, webActionStamp, webActionState } from "./web-action.ts";

const JSON_TYPE = "application/json; charset=utf-8";
const OUTPUT_TAIL = 256 * 1024;
const ONE_PER_ISSUE: ReadonlySet<string> = new Set(["run", "approve", "publish"]);

export interface WebActionsList {
  actions: WebActionView[];
  inProgress: boolean;
}

function json(status: number, body: object, extra: Partial<WebResponse> = {}): WebResponse {
  return { status, contentType: JSON_TYPE, body: JSON.stringify(body), ...extra };
}

function error(status: number, message: string): WebResponse {
  return json(status, { error: message });
}

function actionId(request: ActionRequest, now: Date): string {
  const issue = actionIssue(request);
  return `${webActionStamp(now)}-${request.command}${issue === null ? "" : `-${issue}`}`;
}

async function view(files: WebActionFiles, request: WebRequest, withOutput: boolean): Promise<WebActionView> {
  const startTime = await request.processStart(files.record.pid);
  const output = withOutput ? (await readOutput(request.repoDir, files.record.id)).slice(-OUTPUT_TAIL) : null;
  return webActionView(files, { startTime }, output, request.now);
}

async function views(request: WebRequest): Promise<WebActionView[]> {
  const all = await readWebActions(request.repoDir);
  return (await Promise.all(all.map((files) => view(files, request, false)))).reverse();
}

async function busyRefusal(request: WebRequest, action: ActionRequest): Promise<string | null> {
  const issue = actionIssue(action);
  if (issue !== null && action.command === "refine") {
    const actions = await Promise.all(
      (await readWebActions(request.repoDir)).map(async ({ record, end }) => ({
        record,
        state: webActionState(record, end, { startTime: await request.processStart(record.pid) }, request.now),
      })),
    );
    return refineTurnInProgress(actions, issue, null);
  }
  if (issue === null || !ONE_PER_ISSUE.has(action.command)) return null;
  const working = (await views(request)).find(
    (other) => other.issue === issue && other.state.kind === "running" && ONE_PER_ISSUE.has(other.name),
  );
  if (working !== undefined) {
    return `${working.command} (${working.id}) is still working since ${clockMinutes(new Date(working.startedAt))}; wait for it to end or stop it`;
  }
  if (action.command === "publish") return null;
  return runInProgressRefusal(await latestRunEntry(join(request.repoDir, ".factory", "logs"), issue), request.now);
}

async function start(request: WebRequest): Promise<WebResponse> {
  const parsed = parseActionRequest(request.body);
  if (!parsed.ok) return error(400, parsed.problem);
  const busy = await busyRefusal(request, parsed.request);
  if (busy !== null) return error(409, busy);
  const id = actionId(parsed.request, request.now);
  const stdin = actionStdin(parsed.request);
  const launch: WebActionStart = {
    id,
    command: parsed.request.command,
    args: actionArgs(parsed.request),
    issue: actionIssue(parsed.request),
    ...(stdin === null ? {} : { stdin }),
  };
  return json(202, { id }, { start: launch });
}

async function stop(request: WebRequest, id: string): Promise<WebResponse> {
  const files = await readWebAction(request.repoDir, id);
  if (files === null) return error(404, "not found");
  if (!(await view(files, request, false)).canStop) return error(409, NOTHING_TO_STOP);
  return json(202, { id }, { stop: { pid: files.record.pid, processStart: files.record.processStart } });
}

async function configuredRoles(repoDir: string): Promise<{ roles: Partial<Record<RunRole, RoleChoice>>; problem: string | null }> {
  const path = configPath(repoDir);
  try {
    await access(path);
  } catch {
    return { roles: {}, problem: `${path} does not exist; every target repo needs a .factory/config.ts` };
  }
  try {
    const { workers, verifier, tester } = (await loadConfig(repoDir)).roles;
    return {
      roles: { ...(workers ? { workers } : {}), ...(verifier ? { verifier } : {}), ...(tester ? { tester } : {}) },
      problem: null,
    };
  } catch (failure) {
    return { roles: {}, problem: (failure as Error).message };
  }
}

async function runFormResponse(request: WebRequest, issue: number): Promise<WebResponse> {
  const latest = await latestRunEntry(join(request.repoDir, ".factory", "logs"), issue);
  const configured = await configuredRoles(request.repoDir);
  return json(200, runForm({ issue, previous: latest?.log ?? null, configured: configured.roles, problem: configured.problem, now: request.now }));
}

export type ActionsRoute =
  | { resource: "actions" }
  | { resource: "action" | "action-stop"; actionId: string }
  | { resource: "run-form"; issue: number }
  | { resource: "refinement"; issue: number };

export async function actionsApi(route: ActionsRoute, request: WebRequest): Promise<WebResponse> {
  if (route.resource === "actions") {
    if (request.method === "POST") return start(request);
    if (request.method !== "GET") return error(405, "method not allowed");
    const actions = await views(request);
    const list: WebActionsList = { actions, inProgress: actions.some((action) => action.inProgress) };
    return json(200, list);
  }
  if (route.resource === "action-stop") {
    return request.method === "POST" ? stop(request, route.actionId) : error(405, "method not allowed");
  }
  if (request.method !== "GET") return error(405, "method not allowed");
  if (route.resource === "run-form") return runFormResponse(request, route.issue);
  if (route.resource === "refinement") return json(200, await refinementConversation(request.repoDir, route.issue, await views(request)));
  const files = await readWebAction(request.repoDir, route.actionId);
  return files === null ? error(404, "not found") : json(200, await view(files, request, true));
}
