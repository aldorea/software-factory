import { describe, expect, it } from "vitest";
import { ghProblem } from "../../src/github/gh-problem.ts";

describe("ghProblem", () => {
  it("should say that gh is not available when its command is missing", async () => {
    expect(await ghProblem("factory-test-no-such-gh")).toContain("gh is not available");
  });

  it("should say that gh is not signed in when gh auth status fails, as it does with no session", async () => {
    expect(await ghProblem("false")).toContain("gh is not signed in: false auth status failed with exit code 1");
  });

  it("should find no problem when gh auth status succeeds", async () => {
    expect(await ghProblem("true")).toBeNull();
  });
});
