import type { HumanCriterionRecord, TesterRecord, TesterVerdictRecord, VerificationRecord } from "../coordinator/run-log.ts";
import { checksGroup, criteriaGroup } from "./evidence-view.ts";
import { escapeHtml, logAnchors, RAW_LOG } from "./html.ts";
import type { LogUrl } from "./log-path.ts";

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

function testerBlock(tester: TesterRecord | undefined, logUrl: LogUrl): string {
  if (tester === undefined) return "";
  const lines = [
    "<h4>Acceptance tester</h4>",
    `<p>Agente: ${escapeHtml(`${tester.agent.agent} / ${tester.agent.model}`)}</p>`,
  ];
  lines.push(...logAnchors(logUrl(tester.logPath), RAW_LOG).map((link) => `<p>${link}</p>`));
  if (tester.error !== undefined) lines.push(`<p>Error: ${escapeHtml(tester.error)}</p>`);
  if (tester.verdicts.length > 0) lines.push("<ul>", ...tester.verdicts.map(verdictItem), "</ul>");
  return lines.join("\n");
}

export function verificationSection(verification: VerificationRecord | undefined, logUrl: LogUrl): string {
  if (verification === undefined) return ["<h2>Integrated verification</h2>", "<p>Todavía sin integrated verification</p>"].join("\n");
  const lines = [
    "<h2>Integrated verification</h2>",
    `<p>SHA: ${escapeHtml(verification.sha)}</p>`,
    `<p>Resultado: ${verification.passed ? "pasa" : "falla"}</p>`,
  ];
  if (verification.environment !== undefined) lines.push(`<p>Entorno: ${escapeHtml(verification.environment)}</p>`);
  lines.push(
    checksGroup(verification.checks, logUrl),
    criteriaGroup(verification.criteria, logUrl),
    humanGroup(verification.humanCriteria),
    testerBlock(verification.tester, logUrl),
  );
  return lines.filter(Boolean).join("\n");
}
