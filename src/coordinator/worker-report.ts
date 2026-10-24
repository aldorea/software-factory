export const SCOPE_REQUEST_MARKER = "FACTORY-SCOPE-REQUEST:";
export const DESIGN_QUESTION_MARKER = "FACTORY-DESIGN-QUESTION:";

export interface WorkerReport {
  scopeRequests: string[];
  designQuestion?: string;
}

const NO_QUESTION_TEXT = "The worker gave no text for its question.";

export function parseWorkerReport(summary: string): WorkerReport {
  const scopeRequests: string[] = [];
  let question: string[] | null = null;
  let collecting = false;
  for (const line of summary.split(/\r?\n/)) {
    const text = line.trim();
    if (text.startsWith(SCOPE_REQUEST_MARKER)) {
      collecting = false;
      const path = text.slice(SCOPE_REQUEST_MARKER.length).trim().replace(/^`+|`+$/g, "").trim();
      if (path !== "") scopeRequests.push(path);
    } else if (text.startsWith(DESIGN_QUESTION_MARKER)) {
      question ??= [];
      collecting = true;
      const first = text.slice(DESIGN_QUESTION_MARKER.length).trim();
      if (first !== "") question.push(first);
    } else if (collecting && text !== "") {
      question?.push(text);
    } else {
      collecting = false;
    }
  }
  if (question === null) return { scopeRequests };
  return { scopeRequests, designQuestion: question.length > 0 ? question.join(" ") : NO_QUESTION_TEXT };
}
