import type { CheckRecord, CriterionRecord } from "../coordinator/run-log.ts";
import { escapeHtml } from "./html.ts";

function verdict(passed: boolean): string {
  return passed ? "pasa" : "falla";
}

function checkItem(check: CheckRecord): string {
  const error = check.firstError === undefined ? "" : ` (${check.firstError})`;
  return `<li class="check">${escapeHtml(`${check.name}: ${verdict(check.passed)}${error}`)}</li>`;
}

function criterionItem(criterion: CriterionRecord): string {
  return `<li class="criterion">${escapeHtml(`${criterion.id}: ${verdict(criterion.passed)}`)}</li>`;
}

function group(heading: string, items: string[]): string {
  return items.length === 0 ? "" : [`<h4>${heading}</h4>`, "<ul>", ...items, "</ul>"].join("\n");
}

export function checksGroup(checks: readonly CheckRecord[]): string {
  return group("Checks", checks.map(checkItem));
}

export function criteriaGroup(criteria: readonly CriterionRecord[]): string {
  return group("Criterios con evidencia", criteria.map(criterionItem));
}
