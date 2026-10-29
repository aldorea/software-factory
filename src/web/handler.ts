import { join } from "node:path";
import { abandonedLogs } from "../coordinator/abandoned.ts";
import { readRunEntries, readRunEntry } from "../coordinator/run-history.ts";
import { summarizeRuns } from "../coordinator/stats.ts";
import { page } from "./html.ts";
import { homeView } from "./home-view.ts";
import { hostAllowed } from "./host.ts";
import { logLinks } from "./log-links.ts";
import { matchRoute } from "./routes.ts";
import { readRunFile } from "./run-file.ts";
import { runView } from "./run-view.ts";

export interface WebRequest {
  method: string;
  path: string;
  host: string | undefined;
  repoDir: string;
  port: number;
  now: Date;
}

export interface WebResponse {
  status: number;
  contentType: string;
  body: string;
}

const HTML = "text/html; charset=utf-8";
export const TEXT = "text/plain; charset=utf-8";

function html(status: number, body: string): WebResponse {
  return { status, contentType: HTML, body };
}

function refusal(status: number, title: string): WebResponse {
  return html(status, page(title, `<h1>${title}</h1>`));
}

async function runPage(logsDir: string, runId: string, now: Date): Promise<WebResponse | null> {
  const read = await readRunEntry(logsDir, runId);
  if (read.kind !== "found") return null;
  const logUrl = await logLinks(runId, join(logsDir, runId), read.entry.log);
  return html(200, runView({ entry: read.entry, now, logUrl }));
}

async function runLog(logsDir: string, runId: string, segments: string[]): Promise<WebResponse | null> {
  if ((await readRunEntry(logsDir, runId)).kind !== "found") return null;
  const content = await readRunFile(join(logsDir, runId), segments);
  return content === null ? null : { status: 200, contentType: TEXT, body: content };
}

export async function handleRequest(request: WebRequest): Promise<WebResponse> {
  if (!hostAllowed(request.host, request.port)) return refusal(403, "403 Forbidden");
  if (request.method !== "GET") return refusal(405, "405 Method Not Allowed");
  const logsDir = join(request.repoDir, ".factory", "logs");
  const route = matchRoute(request.path);
  if (route.kind === "home") {
    const { runs, unreadable } = await readRunEntries(logsDir);
    const stats = summarizeRuns(
      runs.map((entry) => entry.log),
      abandonedLogs(runs, request.now),
    );
    return html(200, homeView({ runs, stats, unreadable, now: request.now }));
  }
  if (route.kind === "run") return (await runPage(logsDir, route.runId, request.now)) ?? refusal(404, "404 Not Found");
  if (route.kind === "log") return (await runLog(logsDir, route.runId, route.segments)) ?? refusal(404, "404 Not Found");
  return refusal(404, "404 Not Found");
}
