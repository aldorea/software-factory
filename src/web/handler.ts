import { join } from "node:path";
import { abandonedLogs, runStatus } from "../coordinator/abandoned.ts";
import { readRunEntries, readRunEntry } from "../coordinator/run-history.ts";
import { summarizeRuns } from "../coordinator/stats.ts";
import { page } from "./html.ts";
import { homeView } from "./home-view.ts";
import { hostAllowed } from "./host.ts";
import { logLinks } from "./log-links.ts";
import { matchRoute } from "./routes.ts";
import { readRunFile } from "./run-file.ts";
import { runView } from "./run-view.ts";
import { parseVariant, prototypeHome, prototypeRunPage, readActivity, readEvidence } from "./prototype-variants.ts";
import { readFile } from "node:fs/promises";
import { resolveRunFile } from "./run-file.ts";

export interface WebRequest {
  method: string;
  path: string;
  host: string | undefined;
  repoDir: string;
  port: number;
  now: Date;
  variant?: string | null;
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

async function runPage(logsDir: string, runId: string, now: Date, variantParam?: string | null): Promise<WebResponse | null> {
  const read = await readRunEntry(logsDir, runId);
  if (read.kind !== "found") return null;
  const logUrl = await logLinks(runId, join(logsDir, runId), read.entry.log);
  const variant = parseVariant(variantParam ?? null);
  if (variant !== null) return html(200, prototypeRunPage(variant, read.entry, now, logUrl, await readActivity(read.entry, logUrl), await readEvidence(read.entry, join(logsDir, runId))));
  return html(200, runView({ entry: read.entry, now, logUrl }));
}

async function runLog(logsDir: string, runId: string, segments: string[]): Promise<WebResponse | null> {
  if ((await readRunEntry(logsDir, runId)).kind !== "found") return null;
  const media = /\.(png|jpe?g|webm|mp4)$/i.exec(segments.at(-1) ?? "");
  if (media) {
    const file = await resolveRunFile(join(logsDir, runId), segments);
    const types: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webm: "video/webm", mp4: "video/mp4" };
    return file === null ? null : { status: 200, contentType: types[(media[1] ?? "").toLowerCase()] ?? "application/octet-stream", body: (await readFile(file)) as unknown as string };
  }
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
    const variant = parseVariant(request.variant ?? null);
    if (variant !== null) {
      const activities = new Map();
      for (const entry of runs) {
        if (runStatus(entry, request.now) !== "running") continue;
        activities.set(entry.dir, await readActivity(entry, await logLinks(entry.dir, join(logsDir, entry.dir), entry.log)));
      }
      return html(200, prototypeHome(variant, { runs, stats, unreadable, now: request.now }, activities));
    }
    return html(200, homeView({ runs, stats, unreadable, now: request.now }));
  }
  if (route.kind === "run") return (await runPage(logsDir, route.runId, request.now, request.variant)) ?? refusal(404, "404 Not Found");
  if (route.kind === "log") return (await runLog(logsDir, route.runId, route.segments)) ?? refusal(404, "404 Not Found");
  return refusal(404, "404 Not Found");
}
