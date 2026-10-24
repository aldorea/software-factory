import { execOk } from "../workers/sh.ts";
import { isTestFile, type ChangeStatus, type DiffChange } from "./gate.ts";

const STATUSES: Record<string, ChangeStatus> = { A: "added", M: "modified", D: "deleted", T: "modified" };

export async function changedPaths(repoDir: string, baseRef: string, headRef: string): Promise<DiffChange[]> {
  const out = await execOk("git", ["-C", repoDir, "diff", "--name-status", "--no-renames", "-z", `${baseRef}...${headRef}`]);
  const parts = out.split("\0").filter((part) => part !== "");
  const changes: DiffChange[] = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const status = STATUSES[(parts[index] ?? "").charAt(0)];
    const path = parts[index + 1];
    if (status === undefined || path === undefined) throw new Error(`unexpected diff entry ${parts[index]} ${path}`);
    changes.push({ path, status });
  }
  return changes;
}

export async function testFilesAt(repoDir: string, ref: string): Promise<Set<string>> {
  const out = await execOk("git", ["-C", repoDir, "ls-tree", "-r", "--name-only", "-z", ref]);
  return new Set(out.split("\0").filter((path) => path !== "" && isTestFile(path)));
}
