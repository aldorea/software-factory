import { describe, expect, it } from "vitest";
import { ghProblem } from "../../src/github/gh.ts";

describe("ghProblem", () => {
  it("should say that gh is not available when its command is missing", async () => {
    expect(await ghProblem("factory-test-no-such-gh")).toContain("gh is not available");
  });

  it("should say that gh is not signed in when its command fails, as gh auth status does with no session", async () => {
    expect(await ghProblem("false")).toContain("gh is not signed in: false auth status failed with exit code 1");
  });

  it("should find no problem when the command answers", async () => {
    expect(await ghProblem("true")).toBeNull();
  });
});
