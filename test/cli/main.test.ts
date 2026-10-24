import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, type CliEnv } from "../../src/cli/main.ts";
import type { GitHub } from "../../src/github/github.ts";
import { ghGitHub } from "../../src/github/gh.ts";
import { readApproval } from "../../src/spec/approval.ts";
import { execOk } from "../../src/workers/sh.ts";
import { FakeGitHub } from "../fakes/github.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

const BRANCH = "factory/42-saved-searches";
const issueBody = "## Acceptance criteria\n\n- [ ] A1 one\n- [ ] A2 two\n- [ ] A3 three\n";

async function git(dir: string, ...args: string[]): Promise<string> {
  return (await execOk("git", ["-C", dir, ...args])).trim();
}

async function targetRepo(spec: string): Promise<string> {
  const dir = await temp.make("cli-test-");
  await execOk("git", ["init", "-q", "-b", BRANCH, dir]);
  await git(dir, "config", "user.name", "t");
  await git(dir, "config", "user.email", "t@t");
  await mkdir(join(dir, "specs"));
  await writeFile(join(dir, "specs", "42.md"), spec);
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "Spec #42");
  return dir;
}

function cli(cwd: string, github: GitHub = new FakeGitHub([{ number: 42, title: "x", body: issueBody }])) {
  const out: string[] = [];
  const err: string[] = [];
  const env: CliEnv = {
    cwd,
    now: () => new Date("2026-10-24T08:00:00.000Z"),
    github: () => github,
    protectedPaths: async () => ["package.json"],
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };
  return { env, out, err };
}

const valid = () => readFile(join(import.meta.dirname, "..", "spec", "fixtures", "valid.md"), "utf8");

describe("factory CLI", () => {
  it("should exit zero on a valid spec when validating, taking the target repo from the current directory", async () => {
    const repoDir = await targetRepo(await valid());
    const { env, out } = cli(repoDir);

    expect(await main(["validate", "42"], env)).toBe(0);
    expect(out.join("\n")).toContain(`specs/42.md on ${BRANCH} is valid`);
  });

  it("should exit non-zero and list the problems of an invalid spec", async () => {
    const repoDir = await targetRepo("# Spec\n\nNo block.\n");
    const { env, err } = cli(await temp.make("elsewhere-"));

    expect(await main(["validate", "42", repoDir], env)).toBe(1);
    expect(err.join("\n")).toContain("the spec must hold exactly one ```json factory-spec block, found 0");
  });

  it("should approve a valid spec and say where it committed", async () => {
    const repoDir = await targetRepo(await valid());
    const { env, out } = cli(repoDir);

    expect(await main(["approve", "42"], env)).toBe(0);
    expect(out.join("\n")).toContain(`Approved spec #42 on ${BRANCH}`);
    expect(readApproval(await readFile(join(repoDir, "specs", "42.md"), "utf8")).kind).toBe("approved");
  });

  it("should exit non-zero with a clear message when the integration branch does not exist", async () => {
    const repoDir = await targetRepo(await valid());
    const { env, err } = cli(repoDir);

    expect(await main(["approve", "7"], env)).toBe(1);
    expect(err.join("\n")).toContain("no integration branch factory/7-<slug>");
  });

  it("should exit non-zero with a clear message when gh is missing", async () => {
    const repoDir = await targetRepo(await valid());
    const { env, err } = cli(repoDir, ghGitHub({ repoDir, command: "factory-test-no-such-gh" }));

    expect(await main(["validate", "42"], env)).toBe(1);
    expect(err.join("\n")).toContain("gh is not available");
  });

  it("should print the usage and exit non-zero on an unknown command or a bad issue number", async () => {
    const { env, err } = cli(await temp.make("cli-usage-"));

    expect(await main(["deploy", "42"], env)).toBe(2);
    expect(await main(["approve", "forty-two"], env)).toBe(2);
    expect(err.join("\n")).toContain("usage: factory <approve|validate> <issue> [target-repo]");
  });
});
