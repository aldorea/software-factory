import { describe, expect, it } from "vitest";
import { criteriaHash, readApproval, technicalHash, writeApproval } from "../../src/spec/approval.ts";
import { issueCriteria } from "../../src/spec/issue.ts";

const issueBody = [
  "## What to build",
  "",
  "Saved searches.",
  "",
  "## Acceptance criteria",
  "",
  "- [ ] A1 Saved searches are listed.",
  "- [ ] A2 A search can be renamed.",
  "",
  "## Notes",
  "",
  "Anything.",
  "",
].join("\n");

const spec = "# Spec #42\n\nProse.\n\n```json factory-spec\n{}\n```\n";

describe("issueCriteria", () => {
  it("should read the criterion IDs of the criteria section", () => {
    expect(issueCriteria(issueBody)).toEqual(["A1", "A2"]);
  });

  it("should read IDs written in bold, checked or followed by punctuation", () => {
    const body = "## Acceptance criteria\n\n- [x] **A1** one\n- A2: two\n* [ ] A3. three\n- not a criterion\n";

    expect(issueCriteria(body)).toEqual(["A1", "A2", "A3"]);
  });

  it("should return null when the issue has no criteria section", () => {
    expect(issueCriteria("## What to build\n\nThings.\n")).toBeNull();
  });
});

describe("criteriaHash", () => {
  it("should hash the criteria section of the issue, from its heading to the next heading", () => {
    expect(criteriaHash(issueBody)).toBe("56b9bc5dab5a561e95aaafeee81b3e90f5f791c7762ebddd1d32b7ba177cd85f");
  });

  it("should ignore trailing whitespace and line endings, which GitHub's editor changes freely", () => {
    const edited = issueBody.replace("listed.", "listed.   ").replaceAll("\n", "\r\n");

    expect(criteriaHash(edited)).toBe(criteriaHash(issueBody));
  });

  it("should change when a criterion changes", () => {
    expect(criteriaHash(issueBody.replace("renamed", "deleted"))).not.toBe(criteriaHash(issueBody));
  });

  it("should not change when a section other than the criteria changes", () => {
    expect(criteriaHash(issueBody.replace("Anything.", "Something else."))).toBe(criteriaHash(issueBody));
  });
});

describe("approval header", () => {
  const approval = {
    approvedAt: new Date("2026-10-24T08:00:00.000Z"),
    criteriaHash: "a".repeat(64),
    technicalHash: "b".repeat(64),
  };

  it("should write the date and both hashes at the top of the spec and read them back", () => {
    const approved = writeApproval(spec, approval);

    expect(approved).toBe(
      [
        "<!-- factory-approval",
        "approved-at: 2026-10-24T08:00:00.000Z",
        `criteria-sha256: ${"a".repeat(64)}`,
        `technical-sha256: ${"b".repeat(64)}`,
        "-->",
        spec,
      ].join("\n"),
    );
    expect(readApproval(approved)).toEqual({ kind: "approved", approval });
  });

  it("should replace an existing header instead of adding a second one", () => {
    const later = { ...approval, approvedAt: new Date("2026-10-25T09:00:00.000Z"), technicalHash: "c".repeat(64) };

    expect(writeApproval(writeApproval(spec, approval), later)).toBe(writeApproval(spec, later));
  });

  it("should report a spec with no header as not approved", () => {
    expect(readApproval(spec)).toEqual({ kind: "not-approved" });
  });

  it("should report a header with a missing field as malformed", () => {
    const broken = "<!-- factory-approval\napproved-at: 2026-10-24T08:00:00.000Z\n-->\n" + spec;

    expect(readApproval(broken)).toEqual({ kind: "malformed", reason: "the approval header has no criteria-sha256" });
  });

  it("should leave the technical hash unchanged by the header, so approving does not invalidate itself", () => {
    expect(technicalHash(writeApproval(spec, approval))).toBe(technicalHash(spec));
  });

  it("should change the technical hash when the prose around the block changes", () => {
    expect(technicalHash(spec.replace("Prose.", "Other prose."))).not.toBe(technicalHash(spec));
  });

  it("should ignore trailing whitespace and line endings in the technical hash", () => {
    expect(technicalHash(spec.replace("Prose.", "Prose.  ").replaceAll("\n", "\r\n"))).toBe(technicalHash(spec));
  });
});
