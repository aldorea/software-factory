import { describe, expect, it } from "vitest";
import { dockerProblem } from "../../src/workers/docker.ts";

describe("dockerProblem", () => {
  it("should say that Docker is not available when its command is missing", async () => {
    expect(await dockerProblem("factory-test-no-such-docker")).toContain("Docker is not available");
  });

  it("should say that Docker is not running when its command fails, as docker info does with no daemon", async () => {
    expect(await dockerProblem("false")).toContain("Docker is not running: false info failed with exit code 1");
  });

  it("should find no problem when the command answers", async () => {
    expect(await dockerProblem("true")).toBeNull();
  });
});
