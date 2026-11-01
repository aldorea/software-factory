import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ghGitHub } from "../../src/github/gh.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();

afterEach(() => temp.removeAll());

async function stubGh(body: string): Promise<{ repoDir: string; command: string }> {
  const dir = await temp.make("gh-stub-");
  const command = join(dir, "gh");
  await writeFile(command, `#!/bin/sh\n${body}\n`);
  await chmod(command, 0o755);
  return { repoDir: dir, command };
}

describe("ghGitHub pushDestination", () => {
  it("should give the HTTPS url of the repo that gh repo view names, with the gh helper as the only credential helper", async () => {
    const { repoDir, command } = await stubGh(
      `if [ "$1 $2 $3" = "repo view --json" ] && [ "$4" = nameWithOwner ]; then echo '{"nameWithOwner":"aldorea/askwell"}'; else exit 1; fi`,
    );

    const destination = await ghGitHub({ repoDir, command }).pushDestination();

    expect(destination).toEqual({
      url: "https://github.com/aldorea/askwell.git",
      gitArgs: ["-c", "credential.helper=", "-c", `credential.helper=!${command} auth git-credential`],
    });
  });

  it("should carry no token in the url or in the arguments", async () => {
    const { repoDir, command } = await stubGh(`echo '{"nameWithOwner":"aldorea/askwell"}'`);

    const destination = await ghGitHub({ repoDir, command }).pushDestination();

    expect(JSON.stringify(destination)).not.toMatch(/token|@github\.com|ghp_|gho_/);
  });

  it("should fail with the message of gh when gh cannot tell the repo", async () => {
    const { repoDir, command } = await stubGh(`echo "no git remotes found" >&2\nexit 1`);

    await expect(ghGitHub({ repoDir, command }).pushDestination()).rejects.toThrow(/gh repo view failed \(1\): no git remotes found/);
  });
});
