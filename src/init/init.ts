import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { factoryFilesFor, gitignoreUpdate, initRefusal, planFiles, type RepoGitFacts, type RepoManifestFacts } from "./plan.ts";
import { exec } from "../workers/sh.ts";

const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json"];

async function readGitFacts(repoDir: string): Promise<RepoGitFacts> {
  const top = await exec("git", ["-C", repoDir, "rev-parse", "--show-toplevel"]);
  const isRepoRoot = top.exitCode === 0 && (await realpath(top.stdout.trim())) === (await realpath(repoDir));
  const origin = await exec("git", ["-C", repoDir, "remote", "get-url", "origin"]);
  return { isRepoRoot, hasOrigin: origin.exitCode === 0 };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readManifestFacts(repoDir: string): Promise<RepoManifestFacts> {
  const present = await Promise.all(LOCKFILES.map((lockfile) => exists(join(repoDir, lockfile))));
  return {
    lockfiles: LOCKFILES.filter((_, index) => present[index]),
    packageJson: await readOptional(join(repoDir, "package.json")),
  };
}

async function writeNew(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, { flag: "wx" });
}

export async function initRepo(repoDir: string): Promise<string[]> {
  const refusal = initRefusal(repoDir, await readGitFacts(repoDir));
  if (refusal !== null) throw new Error(refusal);
  const files = factoryFilesFor(repoDir, await readManifestFacts(repoDir));
  const present = await Promise.all(files.map((file) => exists(join(repoDir, file.path))));
  const plan = planFiles(
    files,
    files.filter((_, index) => present[index]).map((file) => file.path),
  );
  const lines: string[] = [];
  for (const { file, action } of plan) {
    if (action === "skip") {
      lines.push(`skipped ${file.path} (already exists)`);
      continue;
    }
    await writeNew(join(repoDir, file.path), file.content);
    lines.push(`wrote ${file.path}`);
  }
  const ignoreFile = join(repoDir, ".gitignore");
  const current = await readOptional(ignoreFile);
  const updated = gitignoreUpdate(current);
  if (updated === null) {
    lines.push("skipped .gitignore (already lists the factory entries)");
  } else {
    await writeFile(ignoreFile, updated);
    lines.push(current === null ? "wrote .gitignore" : "updated .gitignore");
  }
  return lines;
}
