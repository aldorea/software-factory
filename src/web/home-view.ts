import type { RunEntry } from "../coordinator/run-history.ts";
import { anchor, badge, escapeHtml, link, page, titledList } from "./html.ts";
import { relativeTime } from "./relative-time.ts";
import { shouldReload } from "./reload.ts";
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
  return anchor(pullRequest.url, `#${pullRequest.number}`);
}

function runIdCell(entry: RunEntry): string {
  if (parseRunId(entry.dir) === null) return escapeHtml(entry.log.runId);
  return link(`/runs/${entry.dir}`, entry.log.runId);
}

function runRow(entry: RunEntry, now: Date): string {
  const { log } = entry;
  return [
    "<tr>",
    `<td>#${escapeHtml(String(log.issue))}</td>`,
    `<td>${runIdCell(entry)}</td>`,
    `<td>${badge(log.result)}</td>`,
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
  return titledList("h2", "run.json ilegibles", unreadable.map((name) => `<li>${escapeHtml(name)}</li>`));
}

export function homeView({ runs, stats, unreadable, now }: HomeData): string {
  const newestFirst = [...runs].reverse();
  const statistics = runs.length === 0 ? "" : statsView(stats);
  return page(
    "factory web",
    [statistics, "<h1>Runs</h1>", runsTable(newestFirst, now), unreadableList(unreadable)].filter(Boolean).join("\n"),
    { reload: shouldReload(runs.map((entry) => entry.log)) },
  );
}
