import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exec } from "../../src/workers/sh.ts";

const BIN = join(import.meta.dirname, "..", "..", "src", "cli", "factory.ts");

describe("factory bin", () => {
  it("should start under plain node, which only strips types, and print the usage", async () => {
    const result = await exec(process.execPath, [BIN]);
    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    expect(result.stderr).toContain("usage: factory");
    expect(result.exitCode).not.toBe(0);
  });
});
