import { createHash } from "node:crypto";
import { criteriaSection } from "./issue.ts";

export interface Approval {
  approvedAt: Date;
  criteriaHash: string;
  technicalHash: string;
}

export type ApprovalState =
  | { kind: "approved"; approval: Approval }
  | { kind: "not-approved" }
  | { kind: "malformed"; reason: string };

const HEADER_OPEN = "<!-- factory-approval";
const HEADER_CLOSE = "-->";

export function normalize(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n+$/, "");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function criteriaHash(issueBody: string): string | null {
  const section = criteriaSection(issueBody);
  return section === null ? null : sha256(normalize(section));
}

export function technicalHash(specText: string): string {
  return sha256(normalize(stripApproval(specText)));
}

function headerLines(text: string): { fields: string[]; rest: string } | null {
  if (!text.startsWith(HEADER_OPEN)) return null;
  const lines = text.split("\n");
  const close = lines.findIndex((line) => line.trimEnd() === HEADER_CLOSE);
  if (close === -1) return null;
  return { fields: lines.slice(1, close), rest: lines.slice(close + 1).join("\n") };
}

export function stripApproval(text: string): string {
  return headerLines(text)?.rest ?? text;
}

export function writeApproval(specText: string, approval: Approval): string {
  return [
    HEADER_OPEN,
    `approved-at: ${approval.approvedAt.toISOString()}`,
    `criteria-sha256: ${approval.criteriaHash}`,
    `technical-sha256: ${approval.technicalHash}`,
    HEADER_CLOSE,
    stripApproval(specText),
  ].join("\n");
}

export function readApproval(specText: string): ApprovalState {
  if (!specText.startsWith(HEADER_OPEN)) return { kind: "not-approved" };
  const header = headerLines(specText);
  if (!header) return { kind: "malformed", reason: `the approval header has no closing ${HEADER_CLOSE}` };
  const fields = new Map<string, string>();
  for (const line of header.fields) {
    const match = /^([a-z0-9-]+):\s*(.*?)\s*$/.exec(line);
    if (match?.[1] && match[2] !== undefined) fields.set(match[1], match[2]);
  }
  const approvedAt = fields.get("approved-at");
  const criteria = fields.get("criteria-sha256");
  const technical = fields.get("technical-sha256");
  if (!approvedAt || Number.isNaN(Date.parse(approvedAt))) {
    return { kind: "malformed", reason: "the approval header has no valid approved-at" };
  }
  if (!criteria) return { kind: "malformed", reason: "the approval header has no criteria-sha256" };
  if (!technical) return { kind: "malformed", reason: "the approval header has no technical-sha256" };
  return {
    kind: "approved",
    approval: { approvedAt: new Date(approvedAt), criteriaHash: criteria, technicalHash: technical },
  };
}
