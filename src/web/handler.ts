import { join } from "node:path";
import { readRunEntries, readRunEntry } from "../coordinator/run-history.ts";
import { summarizeRuns } from "../coordinator/stats.ts";
import { page } from "./html.ts";
import { homeView } from "./home-view.ts";
import { hostAllowed } from "./host.ts";
import { matchRoute } from "./routes.ts";
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

function html(status: number, body: string): WebResponse {
  return { status, contentType: HTML, body };
}

function refusal(status: number, title: string): WebResponse {
  return html(status, page(title, `<h1>${title}</h1>`));
}

export async function handleRequest(request: WebRequest): Promise<WebResponse> {
  if (!hostAllowed(request.host, request.port)) return refusal(403, "403 Forbidden");
  if (request.method !== "GET") return refusal(405, "405 Method Not Allowed");
  const logsDir = join(request.repoDir, ".factory", "logs");
  const route = matchRoute(request.path);
  if (route.kind === "home") {
    const { runs, unreadable } = await readRunEntries(logsDir);
    const stats = summarizeRuns(runs.map((entry) => entry.log));
    return html(200, homeView({ runs, stats, unreadable, now: request.now }));
  }
  if (route.kind === "run") {
    const entry = await readRunEntry(logsDir, route.runId);
    if (entry !== null && entry !== "unreadable") return html(200, runView({ entry, now: request.now }));
  }
  return refusal(404, "404 Not Found");
}
