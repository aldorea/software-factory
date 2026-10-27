import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pushBranch } from "../git/repo.ts";
import { exec, execOk } from "../workers/sh.ts";

export function evidenceBranchName(issue: number): string {
  return `factory-evidence/${issue}`;
}

export function evidencePath(runId: string, criterionId: string, attachment: string): string {
  return `${runId}/${criterionId}/${basename(attachment)}`;
}

export interface EvidenceFile {
  source: string;
  path: string;
}

export interface CriterionFiles {
  id: string;
  attachments: string[];
}

export function evidenceFiles(runId: string, runDir: string, criteria: CriterionFiles[]): EvidenceFile[] {
  return criteria.flatMap((criterion) =>
    criterion.attachments.map((attachment) => ({
      source: join(runDir, attachment),
      path: evidencePath(runId, criterion.id, attachment),
    })),
  );
}

export interface EvidencePublication {
  repoDir: string;
  remote: string;
  issue: number;
  runId: string;
  files: EvidenceFile[];
}

export async function publishEvidence(publication: EvidencePublication): Promise<string> {
  const { repoDir, remote, issue, runId, files } = publication;
  const branch = evidenceBranchName(issue);
  const scratch = await mkdtemp(join(tmpdir(), "factory-evidence-"));
  try {
    const stage = join(scratch, "stage");
    for (const file of files) {
      const target = join(stage, file.path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(file.source, target);
    }
    const gitDir = (await execOk("git", ["-C", repoDir, "rev-parse", "--absolute-git-dir"])).trim();
    const options = { cwd: stage, env: { GIT_INDEX_FILE: join(scratch, "index") } };
    const parent = await parentCommit(repoDir, remote, branch);
    if (parent !== null) await execOk("git", ["--git-dir", gitDir, "read-tree", parent], options);
    await execOk("git", ["--git-dir", gitDir, "--work-tree", stage, "add", "--force", "--no-all", "--", "."], options);
    const tree = (await execOk("git", ["--git-dir", gitDir, "write-tree"], options)).trim();
    const commit = (
      await execOk(
        "git",
        ["--git-dir", gitDir, "commit-tree", tree, ...(parent === null ? [] : ["-p", parent]), "-m", `Evidence of run ${runId}`],
        options,
      )
    ).trim();
    await execOk("git", ["-C", repoDir, "update-ref", `refs/heads/${branch}`, commit]);
    await pushBranch(repoDir, remote, branch);
    return commit;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function parentCommit(repoDir: string, remote: string, branch: string): Promise<string | null> {
  const local = await exec("git", ["-C", repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
  const fetched = await exec("git", ["-C", repoDir, "fetch", "--quiet", remote, `refs/heads/${branch}`]);
  const remoteTip = fetched.exitCode === 0 ? (await execOk("git", ["-C", repoDir, "rev-parse", "FETCH_HEAD"])).trim() : null;
  const localTip = local.exitCode === 0 ? local.stdout.trim() : null;
  if (localTip === null || remoteTip === null) return localTip ?? remoteTip;
  const ahead = await exec("git", ["-C", repoDir, "merge-base", "--is-ancestor", remoteTip, localTip]);
  return ahead.exitCode === 0 ? localTip : remoteTip;
}
