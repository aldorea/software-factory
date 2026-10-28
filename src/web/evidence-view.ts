import type { CheckRecord, CriterionRecord } from "../coordinator/run-log.ts";
import { escapeHtml, FULL_OUTPUT, logAnchors } from "./html.ts";
import type { LogUrl } from "./log-path.ts";

function verdict(passed: boolean): string {
  return passed ? "pasa" : "falla";
}

function item(className: string, text: string, outputUrl: string | null): string {
  return `<li class="${className}">${[escapeHtml(text), ...logAnchors(outputUrl, FULL_OUTPUT)].join(" ")}</li>`;
}

function checkItem(check: CheckRecord, logUrl: LogUrl): string {
  const error = check.firstError === undefined ? "" : ` (${check.firstError})`;
  return item("check", `${check.name}: ${verdict(check.passed)}${error}`, logUrl(check.outputLog));
}

function criterionItem(criterion: CriterionRecord, logUrl: LogUrl): string {
  return item("criterion", `${criterion.id}: ${verdict(criterion.passed)}`, logUrl(criterion.outputLog));
}

function group(heading: string, items: string[]): string {
  return items.length === 0 ? "" : [`<h4>${heading}</h4>`, "<ul>", ...items, "</ul>"].join("\n");
}

export function checksGroup(checks: readonly CheckRecord[], logUrl: LogUrl): string {
  return group("Checks", checks.map((check) => checkItem(check, logUrl)));
}

export function criteriaGroup(criteria: readonly CriterionRecord[], logUrl: LogUrl): string {
  return group("Criterios con evidencia", criteria.map((criterion) => criterionItem(criterion, logUrl)));
}
