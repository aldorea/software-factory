import { describe, expect, it } from "vitest";
import { activityLine } from "../../src/cli/activity-line.ts";
import type { ActivityEvent } from "../../src/workers/types.ts";

const at = new Date(2026, 9, 28, 10, 2, 20);
const line = (event: ActivityEvent, source = "S1") => activityLine({ source, at, event });

describe("activity line", () => {
  it("should start with the local time as hh:mm:ss and the prefix of the source", () => {
    expect(line({ kind: "tool", tool: "Edit", target: "src/api/users.ts" })).toBe("10:02:20 S1 · Edit src/api/users.ts");
  });

  it("should pad the hours, minutes and seconds to two digits", () => {
    const early = new Date(2026, 9, 28, 4, 5, 9);

    expect(activityLine({ source: "S2", at: early, event: { kind: "tool", tool: "Read" } })).toBe("04:05:09 S2 · Read");
  });

  it("should show a message between quotes", () => {
    expect(line({ kind: "message", text: "Tests pass. Writing the report." })).toBe('10:02:20 S1 · "Tests pass. Writing the report."');
  });

  it("should show a tool with no target by its name alone", () => {
    expect(line({ kind: "tool", tool: "ListAgents" })).toBe("10:02:20 S1 · ListAgents");
  });

  it("should show the end of an attempt by how it ended", () => {
    expect(line({ kind: "end", outcome: "completed" })).toBe("10:02:20 S1 · attempt ended");
    expect(line({ kind: "end", outcome: "failed" })).toBe("10:02:20 S1 · attempt failed");
  });

  it("should take any prefix, as the verifier and the tester will give theirs", () => {
    expect(line({ kind: "tool", tool: "Read" }, "verifier A3")).toBe("10:02:20 verifier A3 · Read");
  });
});
