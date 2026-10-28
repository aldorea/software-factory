import type { HumanCriterionRecord, TesterRecord, TesterVerdictRecord, VerificationRecord } from "../coordinator/run-log.ts";
import { checksGroup, criteriaGroup, verdict } from "./evidence-view.ts";
import { bullets, escapeHtml, logAnchors, RAW_LOG, titledList } from "./html.ts";
import type { LogUrl } from "./log-path.ts";

function humanItem(criterion: HumanCriterionRecord): string {
  const attachments = criterion.attachments.length === 0 ? "" : ` (${criterion.attachments.join(", ")})`;
  return `<li class="human-criterion">${escapeHtml(`${criterion.id}: ${criterion.reason}${attachments}`)}</li>`;
}

function humanGroup(criteria: readonly HumanCriterionRecord[]): string {
  if (criteria.length === 0) return "";
  return titledList("h4", "Criterios human", criteria.map(humanItem));
}

function verdictItem(testerVerdict: TesterVerdictRecord): string {
  const evidence = testerVerdict.evidence.length === 0 ? "" : ` [${testerVerdict.evidence.join(", ")}]`;
  const text = `${testerVerdict.id}: ${verdict(testerVerdict.passed)} (${testerVerdict.observation})${evidence}`;
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
  if (tester.verdicts.length > 0) lines.push(bullets(tester.verdicts.map(verdictItem)));
  return lines.join("\n");
}

export function verificationSection(verification: VerificationRecord | undefined, logUrl: LogUrl): string {
  if (verification === undefined) return ["<h2>Integrated verification</h2>", "<p>Todavía sin integrated verification</p>"].join("\n");
  const lines = [
    "<h2>Integrated verification</h2>",
    `<p>SHA: ${escapeHtml(verification.sha)}</p>`,
    `<p>Resultado: ${verdict(verification.passed)}</p>`,
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
