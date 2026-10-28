import type { CheckRecord, CriterionRecord } from "../coordinator/run-log.ts";
import { badge, escapeHtml, FULL_OUTPUT, logAnchors, titledList } from "./html.ts";
import type { LogUrl } from "./log-path.ts";

export function verdict(passed: boolean): string {
  return passed ? "pasa" : "falla";
}

export function verdictBadge(passed: boolean): string {
  return badge(verdict(passed));
}

function item(className: string, label: string, passed: boolean, note: string, outputUrl: string | null): string {
  const text = `${escapeHtml(label)}: ${verdictBadge(passed)}${escapeHtml(note)}`;
  return `<li class="${className}">${[text, ...logAnchors(outputUrl, FULL_OUTPUT)].join(" ")}</li>`;
}

export function checkItem(check: CheckRecord, logUrl: LogUrl): string {
  const error = check.firstError === undefined ? "" : ` (${check.firstError})`;
  return item("check", check.name, check.passed, error, logUrl(check.outputLog));
}

function criterionItem(criterion: CriterionRecord, logUrl: LogUrl): string {
  return item("criterion", criterion.id, criterion.passed, "", logUrl(criterion.outputLog));
}

function group(heading: string, items: string[]): string {
  return items.length === 0 ? "" : titledList("h4", heading, items);
}

export function checksGroup(checks: readonly CheckRecord[], logUrl: LogUrl): string {
  return group("Checks", checks.map((check) => checkItem(check, logUrl)));
}

export function criteriaGroup(criteria: readonly CriterionRecord[], logUrl: LogUrl): string {
  return group("Criterios con evidencia", criteria.map((criterion) => criterionItem(criterion, logUrl)));
}
