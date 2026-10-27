import { describe, expect, it } from "vitest";
import { evidenceProblem, parseTesterReport } from "../../src/coordinator/tester-report.ts";

const EVIDENCE_DIR = "/repo/.factory/worktrees/run-verification-tester-evidence";

function report(criteria: unknown[], before = "I used the app.\n\n"): string {
  return `${before}\`\`\`json\n${JSON.stringify({ criteria })}\n\`\`\``;
}

const A1_PASSES = { id: "A1", verdict: "pass", observation: "The greeting said hello.", evidence: ["A1/curl.txt"] };
const A2_FAILS = { id: "A2", verdict: "fail", observation: "The page showed bye.", evidence: ["A2/shot.png", "A2/steps.sh"] };

describe("the report of the acceptance tester", () => {
  it("should read a verdict, an observation and the evidence paths of each criterion", () => {
    expect(parseTesterReport(report([A1_PASSES, A2_FAILS]), { ids: ["A1", "A2"], evidenceDir: EVIDENCE_DIR })).toEqual({
      ok: true,
      verdicts: [
        { id: "A1", passed: true, observation: "The greeting said hello.", evidence: ["A1/curl.txt"] },
        { id: "A2", passed: false, observation: "The page showed bye.", evidence: ["A2/shot.png", "A2/steps.sh"] },
      ],
    });
  });

  it("should read the last json block, because the agent may quote an example before its answer", () => {
    const text = `${report([{ id: "A1", verdict: "fail", observation: "example", evidence: ["x"] }])}\n\n${report([A1_PASSES], "")}`;

    const parsed = parseTesterReport(text, { ids: ["A1"], evidenceDir: EVIDENCE_DIR });

    expect(parsed.ok && parsed.verdicts[0]?.passed).toBe(true);
  });

  it("should take an absolute evidence path inside the evidence folder as relative to it", () => {
    const absolute = { ...A1_PASSES, evidence: [`${EVIDENCE_DIR}/A1/curl.txt`] };

    const parsed = parseTesterReport(report([absolute]), { ids: ["A1"], evidenceDir: EVIDENCE_DIR });

    expect(parsed.ok && parsed.verdicts[0]?.evidence).toEqual(["A1/curl.txt"]);
  });

  it.each([
    ["no json block", "Everything works.", "has no json block"],
    ["invalid json", "```json\n{criteria: }\n```", "is not valid JSON"],
    ["a missing criterion", report([A1_PASSES]), "gives no verdict for A2"],
    ["a criterion twice", report([A1_PASSES, A1_PASSES, A2_FAILS]), "gives A1 more than one verdict"],
    ["a criterion it was not asked", report([A1_PASSES, A2_FAILS, { ...A1_PASSES, id: "A9" }]), "gives a verdict for A9, which it was not asked"],
    ["a verdict other than pass or fail", report([{ ...A1_PASSES, verdict: "maybe" }, A2_FAILS]), "A1 must have the verdict pass or fail"],
    ["no observation", report([{ ...A1_PASSES, observation: " " }, A2_FAILS]), "A1 must say what the tester did and saw"],
    ["no evidence", report([{ ...A1_PASSES, evidence: [] }, A2_FAILS]), "A1 must list at least one file of evidence"],
    ["evidence outside its folder", report([{ ...A1_PASSES, evidence: ["../../.env"] }, A2_FAILS]), "the evidence ../../.env of A1 is outside the evidence folder"],
    ["evidence elsewhere on the disk", report([{ ...A1_PASSES, evidence: ["/etc/passwd"] }, A2_FAILS]), "the evidence /etc/passwd of A1 is outside the evidence folder"],
  ])("should refuse a report with %s", (_, text, problem) => {
    const parsed = parseTesterReport(text, { ids: ["A1", "A2"], evidenceDir: EVIDENCE_DIR });

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.problem).toContain(problem);
  });
});

describe("the evidence of the acceptance tester", () => {
  const verdicts = [
    { id: "A1", passed: true, observation: "ok", evidence: ["A1/curl.txt"] },
    { id: "A2", passed: false, observation: "bye", evidence: ["A2/shot.png"] },
  ];

  it("should accept a report whose every evidence path is a file the tester left", () => {
    expect(evidenceProblem(verdicts, new Set(["A1/curl.txt", "A2/shot.png", "A2/extra.log"]))).toBeNull();
  });

  it("should name an evidence path that is not a file the tester left, because the report then claims evidence it does not have", () => {
    expect(evidenceProblem(verdicts, new Set(["A1/curl.txt"]))).toBe("the evidence A2/shot.png of A2 does not exist");
  });
});
