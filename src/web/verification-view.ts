import type { HumanCriterionRecord, TesterRecord, TesterVerdictRecord, VerificationRecord } from "../coordinator/run-log.ts";
import { checksGroup, criteriaGroup } from "./evidence-view.ts";
import { escapeHtml } from "./html.ts";

function humanItem(criterion: HumanCriterionRecord): string {
  const attachments = criterion.attachments.length === 0 ? "" : ` (${criterion.attachments.join(", ")})`;
  return `<li class="human-criterion">${escapeHtml(`${criterion.id}: ${criterion.reason}${attachments}`)}</li>`;
}

function humanGroup(criteria: readonly HumanCriterionRecord[]): string {
  if (criteria.length === 0) return "";
  return ["<h4>Criterios human</h4>", "<ul>", ...criteria.map(humanItem), "</ul>"].join("\n");
}

function verdictItem(verdict: TesterVerdictRecord): string {
  const evidence = verdict.evidence.length === 0 ? "" : ` [${verdict.evidence.join(", ")}]`;
  const text = `${verdict.id}: ${verdict.passed ? "pasa" : "falla"} (${verdict.observation})${evidence}`;
  return `<li class="tester-verdict">${escapeHtml(text)}</li>`;
}

function testerBlock(tester: TesterRecord | undefined): string {
  if (tester === undefined) return "";
  const lines = [
    "<h4>Acceptance tester</h4>",
    `<p>Agente: ${escapeHtml(`${tester.agent.agent} / ${tester.agent.model}`)}</p>`,
  ];
  if (tester.error !== undefined) lines.push(`<p>Error: ${escapeHtml(tester.error)}</p>`);
  if (tester.verdicts.length > 0) lines.push("<ul>", ...tester.verdicts.map(verdictItem), "</ul>");
  return lines.join("\n");
}

export function verificationSection(verification: VerificationRecord | undefined): string {
  if (verification === undefined) return ["<h2>Integrated verification</h2>", "<p>Todavía sin integrated verification</p>"].join("\n");
  const lines = [
    "<h2>Integrated verification</h2>",
    `<p>SHA: ${escapeHtml(verification.sha)}</p>`,
    `<p>Resultado: ${verification.passed ? "pasa" : "falla"}</p>`,
  ];
  if (verification.environment !== undefined) lines.push(`<p>Entorno: ${escapeHtml(verification.environment)}</p>`);
  lines.push(
    checksGroup(verification.checks),
    criteriaGroup(verification.criteria),
    humanGroup(verification.humanCriteria),
    testerBlock(verification.tester),
  );
  return lines.filter(Boolean).join("\n");
}
