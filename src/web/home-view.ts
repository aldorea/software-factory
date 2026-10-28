import type { RunEntry } from "../coordinator/run-history.ts";
import { escapeHtml, page, safeLink } from "./html.ts";
import { relativeTime } from "./relative-time.ts";
import { parseRunId } from "./routes.ts";
import { statsView } from "./stats-view.ts";
import type { RunStats } from "../coordinator/stats.ts";

export interface HomeData {
  runs: RunEntry[];
  stats: RunStats;
  unreadable: string[];
  now: Date;
}

function pullRequestCell(entry: RunEntry): string {
  const pullRequest = entry.log.pullRequest;
  if (pullRequest === undefined) return "";
  const text = `#${pullRequest.number}`;
  const url = safeLink(pullRequest.url);
  return url === null ? escapeHtml(text) : `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`;
}

function runIdCell(entry: RunEntry): string {
  if (parseRunId(entry.dir) === null) return escapeHtml(entry.log.runId);
  return `<a href="/runs/${entry.dir}">${escapeHtml(entry.log.runId)}</a>`;
}

function runRow(entry: RunEntry, now: Date): string {
  const { log } = entry;
  return [
    "<tr>",
    `<td>#${escapeHtml(String(log.issue))}</td>`,
    `<td>${runIdCell(entry)}</td>`,
    `<td>${escapeHtml(log.result)}</td>`,
    `<td>${escapeHtml(relativeTime(entry.modifiedAt, now))}</td>`,
    `<td>${pullRequestCell(entry)}</td>`,
    "</tr>",
  ].join("");
}

function runsTable(runs: RunEntry[], now: Date): string {
  if (runs.length === 0) return "<p>Todavía no hay runs: .factory/logs no tiene ficheros run.json.</p>";
  return [
    "<table>",
    "<thead><tr><th>Issue</th><th>Run ID</th><th>Resultado</th><th>Último cambio</th><th>Pull request</th></tr></thead>",
    "<tbody>",
    ...runs.map((entry) => runRow(entry, now)),
    "</tbody>",
    "</table>",
  ].join("\n");
}

function unreadableList(unreadable: string[]): string {
  if (unreadable.length === 0) return "";
  return ["<h2>run.json ilegibles</h2>", "<ul>", ...unreadable.map((name) => `<li>${escapeHtml(name)}</li>`), "</ul>"].join("\n");
}

export function homeView({ runs, stats, unreadable, now }: HomeData): string {
  const newestFirst = [...runs].reverse();
  const statistics = runs.length === 0 ? "" : statsView(stats);
  return page(
    "factory web",
    [statistics, "<h1>Runs</h1>", runsTable(newestFirst, now), unreadableList(unreadable)].filter(Boolean).join("\n"),
  );
}
