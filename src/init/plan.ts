import { basename } from "node:path";
import type { Check } from "../config/config.ts";
import { factoryFiles, type FactoryFile, type PackageManager } from "./templates.ts";

export interface RepoGitFacts {
  isRepoRoot: boolean;
  hasOrigin: boolean;
}

export interface RepoManifestFacts {
  lockfiles: string[];
  packageJson: string | null;
}

export const GITIGNORE_ENTRIES = [".factory/logs/", ".factory/worktrees/", ".factory/.env"];
export const CHECK_SCRIPTS = ["lint", "typecheck", "test"];

export function initRefusal(repoDir: string, facts: RepoGitFacts): string | null {
  if (!facts.isRepoRoot) return `${repoDir} is not a git repo, or not its root: run factory init from the root of the target repo`;
  if (!facts.hasOrigin) return `${repoDir} has no origin remote: add one (git remote add origin <url>) so the factory can find the default branch`;
  return null;
}

export function imageName(repoDir: string): string {
  const folder = basename(repoDir).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "");
  return `${folder === "" ? "target" : folder}-factory-worker:dev`;
}

export function detectPackageManager(lockfiles: string[]): PackageManager | null {
  if (lockfiles.includes("pnpm-lock.yaml")) return "pnpm";
  if (lockfiles.includes("package-lock.json")) return "npm";
  return null;
}

export function scriptNames(packageJson: string | null): string[] {
  if (packageJson === null) return [];
  let manifest: unknown;
  try {
    manifest = JSON.parse(packageJson);
  } catch {
    return [];
  }
  const scripts = typeof manifest === "object" && manifest !== null ? (manifest as { scripts?: unknown }).scripts : undefined;
  return typeof scripts === "object" && scripts !== null ? Object.keys(scripts) : [];
}

export function deriveChecks(packageManager: PackageManager | null, scripts: string[]): Check[] {
  const install: Check[] =
    packageManager === "pnpm"
      ? [{ name: "install", command: "pnpm install --frozen-lockfile" }]
      : packageManager === "npm"
        ? [{ name: "install", command: "npm ci" }]
        : [];
  const run = packageManager === "pnpm" ? "pnpm" : "npm run";
  const present = CHECK_SCRIPTS.filter((script) => scripts.includes(script));
  return [...install, ...present.map((script) => ({ name: script, command: `${run} ${script}` }))];
}

export function factoryFilesFor(repoDir: string, facts: RepoManifestFacts): FactoryFile[] {
  const packageManager = detectPackageManager(facts.lockfiles);
  const checks = deriveChecks(packageManager, scriptNames(facts.packageJson));
  return factoryFiles({ image: imageName(repoDir), checks, packageManager: packageManager ?? "npm" });
}

export interface FilePlan {
  write: FactoryFile[];
  skip: FactoryFile[];
}

export function planFiles(files: FactoryFile[], existing: string[]): FilePlan {
  return {
    write: files.filter((file) => !existing.includes(file.path)),
    skip: files.filter((file) => existing.includes(file.path)),
  };
}

export function gitignoreUpdate(current: string | null): string | null {
  const present = new Set((current ?? "").split("\n").map((line) => line.trim()));
  const missing = GITIGNORE_ENTRIES.filter((entry) => !present.has(entry));
  if (missing.length === 0) return null;
  const base = current === null || current === "" ? "" : current.endsWith("\n") ? current : `${current}\n`;
  return `${base}${missing.join("\n")}\n`;
}
