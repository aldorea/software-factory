import { afterEach, describe, expect, it } from "vitest";
import { originHeadProblem } from "../../src/git/repo.ts";
import { execOk } from "../../src/workers/sh.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

async function repoWithRemote(): Promise<string> {
  const remote = await temp.make("origin-head-remote-");
  await execOk("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const repo = await temp.make("origin-head-repo-");
  await execOk("git", ["init", "-q", "-b", "main", repo]);
  await execOk("git", ["-C", repo, "config", "user.name", "t"]);
  await execOk("git", ["-C", repo, "config", "user.email", "t@t"]);
  await execOk("git", ["-C", repo, "remote", "add", "origin", remote]);
  await execOk("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
  await execOk("git", ["-C", repo, "push", "-q", "origin", "main"]);
  return repo;
}

describe("originHeadProblem", () => {
  it("should find no problem when origin/HEAD points at a branch", async () => {
    const repo = await repoWithRemote();
    await execOk("git", ["-C", repo, "remote", "set-head", "origin", "--auto"]);

    expect(await originHeadProblem(repo)).toBeNull();
  });

  it("should say origin/HEAD is not set when the clone never resolved it", async () => {
    expect(await originHeadProblem(await repoWithRemote())).toBe("origin/HEAD is not set");
  });
});
