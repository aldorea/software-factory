import { describe, expect, it } from "vitest";
import { dockerignoreProblem } from "../../src/workers/dockerignore.ts";

const MISSING = { problem: ".factory/.dockerignore does not exist, so the build context would hold .factory/.env", fix: "factory init" };
const NOT_EXCLUDED = {
  problem: ".factory/.dockerignore does not exclude .env, so the build context would hold .factory/.env",
  fix: "add .env to .factory/.dockerignore",
};

describe("dockerignoreProblem", () => {
  it("should fail when the file does not exist, and point to factory init that writes it", () => {
    expect(dockerignoreProblem(null)).toEqual(MISSING);
  });

  it("should fail when the file is empty", () => {
    expect(dockerignoreProblem("")).toEqual(NOT_EXCLUDED);
  });

  it("should fail when the file lists other paths but not .env, and point to the line to add since factory init never overwrites the file", () => {
    expect(dockerignoreProblem("node_modules\nlogs/\n")).toEqual(NOT_EXCLUDED);
  });

  it.each([".env", "/.env", "**/.env", ".env*", "*", ".*", "*.env", ".env/", "node_modules\n.env\n", ".env\r\n", "  .env  "])(
    "should accept %j as excluding .env",
    (content) => {
      expect(dockerignoreProblem(content)).toBeNull();
    },
  );

  it.each(["# .env", ".env.example", "foo/.env", ".envrc", "env"])("should not count %j as excluding .env", (content) => {
    expect(dockerignoreProblem(content)).toEqual(NOT_EXCLUDED);
  });

  it("should fail when a later negated pattern puts .env back in the context, since the last matching pattern wins", () => {
    expect(dockerignoreProblem(".env\n!.env\n")).toEqual(NOT_EXCLUDED);
  });

  it("should accept a negation that keeps another file when .env stays excluded after it", () => {
    expect(dockerignoreProblem("!.env.example\n.env\n")).toBeNull();
  });
});
