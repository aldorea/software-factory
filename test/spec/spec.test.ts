import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSpec, validateSpec, type Spec } from "../../src/spec/spec.ts";

const fixture = (name: string) => readFile(join(import.meta.dirname, "fixtures", name), "utf8");

describe("parseSpec", () => {
  it("should read the file map, the base subtask, the subtasks and the evidence of each criterion", async () => {
    const result = parseSpec(await fixture("valid.md"));

    expect(result).toEqual({
      ok: true,
      spec: {
        files: {
          A1: ["src/db/schema.ts", "src/search/list.ts"],
          A2: ["src/search/list.ts"],
          A3: ["src/search/editor.tsx"],
        },
        base: { id: "base", criteria: ["A1"], scope: ["src/db/", "package.json"], dependsOn: [], testChanges: [] },
        subtasks: [
          { id: "list", criteria: ["A2"], scope: ["src/search/list.ts"], dependsOn: [], testChanges: ["test/search.test.ts"] },
          { id: "editor", criteria: ["A3"], scope: ["src/search/editor.tsx"], dependsOn: [], testChanges: [] },
        ],
        criteria: {
          A1: { evidence: "request", level: "subtask" },
          A2: { evidence: "playwright", level: "integration" },
          A3: { evidence: "human", level: "integration", reason: "The layout of the editor is a visual judgement." },
        },
      },
    });
  });

  it("should reject a spec with no factory-spec block", () => {
    expect(parseSpec("# Spec\n\nNo block here.\n")).toEqual({
      ok: false,
      problems: ["the spec must hold exactly one ```json factory-spec block, found 0"],
    });
  });

  it("should reject a spec with two factory-spec blocks, because the coordinator reads only one", async () => {
    const text = await fixture("valid.md");
    const block = text.slice(text.indexOf("```json factory-spec"));

    expect(parseSpec(`${text}\n${block}`)).toEqual({
      ok: false,
      problems: ["the spec must hold exactly one ```json factory-spec block, found 2"],
    });
  });

  it("should reject a block that is not valid JSON and say so", () => {
    const result = parseSpec("```json factory-spec\n{ \"files\": \n```\n");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.problems[0]).toMatch(/^the factory-spec block is not valid JSON/);
  });

  it("should name every field of the block that has the wrong shape", () => {
    const block = {
      files: { A1: "src/a.ts" },
      base: null,
      subtasks: [{ id: "one", criteria: ["A1"], scope: "src/", dependsOn: [], testChanges: [] }],
      criteria: { A1: { evidence: "screenshot", level: "subtask" } },
    };

    expect(parseSpec(specWith(block))).toEqual({
      ok: false,
      problems: [
        "files.A1 must be a list of strings",
        "subtasks[0].scope must be a list of strings",
        "criteria.A1.evidence must be one of playwright, request, human",
      ],
    });
  });
});

describe("validateSpec", () => {
  const issueCriteria = ["A1", "A2", "A3"];
  const protectedPaths = ["package.json", "src/db/schema.ts"];

  async function validSpec(): Promise<Spec> {
    const result = parseSpec(await fixture("valid.md"));
    if (!result.ok) throw new Error(result.problems.join("\n"));
    return result.spec;
  }

  it("should accept a spec whose subtasks cover every criterion of the issue", async () => {
    expect(validateSpec(await validSpec(), { issueCriteria, protectedPaths })).toEqual([]);
  });

  it("should reject a criterion ID that is not in the issue, wherever the spec names it", async () => {
    const spec = await validSpec();
    spec.files.A9 = ["src/x.ts"];
    spec.subtasks[0]?.criteria.push("A9");
    spec.criteria.A9 = { evidence: "request", level: "subtask" };

    expect(validateSpec(spec, { issueCriteria, protectedPaths })).toEqual([
      "files names criterion A9, which is not in the issue",
      "subtask list names criterion A9, which is not in the issue",
      "criteria names criterion A9, which is not in the issue",
    ]);
  });

  it("should reject a criterion of the issue that no subtask holds", async () => {
    const spec = await validSpec();
    spec.subtasks = spec.subtasks.filter((subtask) => subtask.id !== "editor");

    expect(validateSpec(spec, { issueCriteria, protectedPaths })).toEqual(["criterion A3 is in no subtask"]);
  });

  it("should reject a criterion of the issue with no evidence", async () => {
    const spec = await validSpec();
    delete spec.criteria.A2;

    expect(validateSpec(spec, { issueCriteria, protectedPaths })).toEqual(["criterion A2 has no evidence type"]);
  });

  it("should reject overlapping scope paths between subtasks that could share a wave", async () => {
    const spec = await validSpec();
    spec.subtasks[1]!.scope = ["src/search/"];

    expect(validateSpec(spec, { issueCriteria, protectedPaths })).toEqual([
      "subtasks list and editor could share a wave but their scope paths overlap: src/search/list.ts and src/search/",
    ]);
  });

  it("should accept overlapping scope paths when one subtask depends on the other, because they never share a wave", async () => {
    const spec = await validSpec();
    spec.subtasks[1]!.scope = ["src/search/"];
    spec.subtasks[1]!.dependsOn = ["list"];

    expect(validateSpec(spec, { issueCriteria, protectedPaths })).toEqual([]);
  });

  it("should not take a shared name prefix for an overlap, because src/ab is not inside src/a", async () => {
    const spec = await validSpec();
    spec.subtasks[0]!.scope = ["src/a"];
    spec.subtasks[1]!.scope = ["src/ab/"];

    expect(validateSpec(spec, { issueCriteria, protectedPaths })).toEqual([]);
  });

  it("should reject a protected path in the scope of a subtask other than the base subtask", async () => {
    const spec = await validSpec();
    spec.subtasks[0]!.scope.push("src/db/");

    expect(validateSpec(spec, { issueCriteria, protectedPaths })).toEqual([
      "subtask list has the protected path src/db/schema.ts in its scope (src/db/); only the base subtask may change it",
    ]);
  });

  it("should reject a human criterion with no reason", async () => {
    const spec = await validSpec();
    spec.criteria.A3 = { evidence: "human", level: "integration" };

    expect(validateSpec(spec, { issueCriteria, protectedPaths })).toEqual([
      "criterion A3 is human but gives no reason",
    ]);
  });

  it("should reject a dependency on an unknown subtask and a dependency cycle", async () => {
    const spec = await validSpec();
    spec.subtasks[0]!.dependsOn = ["editor", "ghost"];
    spec.subtasks[1]!.dependsOn = ["list"];

    expect(validateSpec(spec, { issueCriteria, protectedPaths })).toEqual([
      "subtask list depends on ghost, which is not a subtask",
      "subtasks list, editor depend on each other in a cycle",
    ]);
  });

  it("should reject two subtasks with the same ID", async () => {
    const spec = await validSpec();
    spec.subtasks[1]!.id = "list";

    expect(validateSpec(spec, { issueCriteria, protectedPaths })).toContain("subtask ID list is used more than once");
  });
});

function specWith(block: unknown): string {
  return `# Spec\n\n\`\`\`json factory-spec\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;
}
