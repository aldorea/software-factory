import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeProblem, nodeProblemOf } from "../../src/cli/node-probe.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

describe("nodeProblem", () => {
  it("should pass on the floor itself and on anything newer", () => {
    expect(nodeProblem("24.22.1", ">=24.22.1")).toBeNull();
    expect(nodeProblem("24.22.2", ">=24.22.1")).toBeNull();
    expect(nodeProblem("24.23.0", ">=24.22.1")).toBeNull();
    expect(nodeProblem("25.0.0", ">=24.22.1")).toBeNull();
  });

  it("should fail on a Node older than the floor, naming both versions", () => {
    expect(nodeProblem("24.22.0", ">=24.22.1")).toBe("Node 24.22.0 is older than 24.22.1, the floor of engines in package.json");
    expect(nodeProblem("22.23.4", ">=24.22.1")).toBe("Node 22.23.4 is older than 24.22.1, the floor of engines in package.json");
  });

  it("should compare versions as numbers, not as text", () => {
    expect(nodeProblem("24.100.0", ">=24.22.1")).toBeNull();
  });

  it("should fail closed on a floor it cannot read", () => {
    expect(nodeProblem("24.22.1", "^24")).toBe("cannot read the floor of Node from engines in package.json: ^24");
  });
});

describe("nodeProblemOf", () => {
  async function factoryWith(content: string | null): Promise<string> {
    const dir = await temp.make("node-probe-");
    if (content !== null) await writeFile(join(dir, "package.json"), content);
    return dir;
  }

  it("should read the floor from the package.json of the factory", async () => {
    const dir = await factoryWith(JSON.stringify({ engines: { node: ">=999.0.0" } }));

    expect(await nodeProblemOf(dir, "24.22.1")).toBe("Node 24.22.1 is older than 999.0.0, the floor of engines in package.json");
    expect(await nodeProblemOf(dir, "1000.0.0")).toBeNull();
  });

  it("should fail closed when the factory has no readable engines.node", async () => {
    expect(await nodeProblemOf(await factoryWith(null), "24.22.1")).toContain("cannot read engines.node");
    expect(await nodeProblemOf(await factoryWith("{}"), "24.22.1")).toContain("cannot read engines.node");
  });
});
