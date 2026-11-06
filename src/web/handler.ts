import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { readRunEntries, readRunEntry } from "../coordinator/run-history.ts";
import { runsResponse, type ApiError } from "./api.ts";
import { readFileInside } from "./file-inside.ts";
import { hostAllowed } from "./host.ts";
import { readLive, readRawLogTails } from "./live-read.ts";
import { logLinks } from "./log-links.ts";
import { runActivity } from "./run-activity.ts";
import { runDetail } from "./run-detail.ts";
import { matchRoute, type Route } from "./routes.ts";

export interface WebRequest {
  method: string;
  path: string;
  host: string | undefined;
  repoDir: string;
  clientDir: string;
  port: number;
  now: Date;
}

export interface WebResponse {
  status: number;
  contentType: string;
  body: string;
}

const HTML = "text/html; charset=utf-8";
const JSON_TYPE = "application/json; charset=utf-8";
export const TEXT = "text/plain; charset=utf-8";

const ASSET_TYPES = new Map<string, string>([
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
]);

function html(status: number, body: string): WebResponse {
  return { status, contentType: HTML, body };
}

function json(status: number, body: object): WebResponse {
  return { status, contentType: JSON_TYPE, body: JSON.stringify(body) };
}

function apiError(status: number, error: string): WebResponse {
  const body: ApiError = { error };
  return json(status, body);
}

function refusal(status: number, title: string): WebResponse {
  return html(status, `<!doctype html>\n<html lang="es">\n<meta charset="utf-8">\n<title>${title}</title>\n<h1>${title}</h1>\n</html>\n`);
}

async function runResponse(logsDir: string, runId: string, now: Date): Promise<WebResponse> {
  const read = await readRunEntry(logsDir, runId);
  if (read.kind !== "found") return apiError(404, "not found");
  const logUrl = await logLinks(runId, join(logsDir, runId), read.entry.log);
  return json(200, runDetail(read.entry, now, logUrl));
}

async function runActivityResponse(logsDir: string, runId: string, now: Date): Promise<WebResponse> {
  const read = await readRunEntry(logsDir, runId);
  if (read.kind !== "found") return apiError(404, "not found");
  return json(200, runActivity(read.entry, await readRawLogTails(logsDir, [read.entry]), now));
}

async function runLog(logsDir: string, runId: string, segments: string[]): Promise<WebResponse | null> {
  if ((await readRunEntry(logsDir, runId)).kind !== "found") return null;
  const content = await readFileInside(join(logsDir, runId), segments);
  return content === null ? null : { status: 200, contentType: TEXT, body: content };
}

async function asset(clientDir: string, segments: string[]): Promise<WebResponse | null> {
  const contentType = ASSET_TYPES.get(extname(segments.at(-1) ?? ""));
  if (contentType === undefined) return null;
  const content = await readFileInside(join(clientDir, "assets"), segments);
  return content === null ? null : { status: 200, contentType, body: content };
}

async function clientPage(clientDir: string): Promise<WebResponse> {
  return html(200, await readFile(join(clientDir, "index.html"), "utf8"));
}

async function api(route: Extract<Route, { kind: "api" }>, request: WebRequest, logsDir: string): Promise<WebResponse> {
  if (request.method !== "GET") return apiError(405, "method not allowed");
  if (route.resource === "run") return runResponse(logsDir, route.runId, request.now);
  if (route.resource === "run-activity") return runActivityResponse(logsDir, route.runId, request.now);
  if (route.resource === "runs") return json(200, runsResponse(await readRunEntries(logsDir), request.now));
  if (route.resource === "live") return json(200, await readLive(logsDir, request.now));
  return apiError(404, "not found");
}

export async function handleRequest(request: WebRequest): Promise<WebResponse> {
  const route = matchRoute(request.path);
  if (!hostAllowed(request.host, request.port)) {
    return route.kind === "api" ? apiError(403, "forbidden") : refusal(403, "403 Forbidden");
  }
  const logsDir = join(request.repoDir, ".factory", "logs");
  if (route.kind === "api") return api(route, request, logsDir);
  if (request.method !== "GET") return refusal(405, "405 Method Not Allowed");
  if (route.kind === "client") return clientPage(request.clientDir);
  if (route.kind === "asset") return (await asset(request.clientDir, route.segments)) ?? refusal(404, "404 Not Found");
  if (route.kind === "log") return (await runLog(logsDir, route.runId, route.segments)) ?? refusal(404, "404 Not Found");
  return refusal(404, "404 Not Found");
}
