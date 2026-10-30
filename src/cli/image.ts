import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/load.ts";
import { dockerignoreProblem } from "../workers/dockerignore.ts";
import { BASE_IMAGE_TAG, buildImages, type ImageBuildOutcome } from "../workers/images.ts";
import { readDockerignore } from "./env-facts.ts";
import type { CliEnv } from "./main.ts";
import { reportErr, reportFailure, reportOut } from "./report.ts";
import { refused } from "./target-repo.ts";

const ID_DIGITS = 12;

function shortId(id: string): string {
  const [algorithm, digest] = id.split(":");
  return digest === undefined ? id.slice(0, ID_DIGITS) : `${algorithm}:${digest.slice(0, ID_DIGITS)}`;
}

function failure(outcome: Exclude<ImageBuildOutcome, { kind: "built" }>, image: string): string {
  switch (outcome.kind) {
    case "base-failed":
      return `the base image ${BASE_IMAGE_TAG} failed to build (docker exit code ${outcome.exitCode})`;
    case "base-unreadable":
      return `could not read the id of the base image ${BASE_IMAGE_TAG} after building it`;
    case "worker-failed":
      return `the worker image ${image} failed to build (docker exit code ${outcome.exitCode})`;
  }
}

export async function image(args: string[], env: CliEnv, usage: string): Promise<number> {
  if (args.length > 1) {
    env.err(usage);
    return 2;
  }
  const repoDir = resolve(env.cwd, args[0] ?? ".");
  if (await refused(repoDir, env)) return 1;
  try {
    const problem = await env.docker();
    if (problem !== null) {
      reportFailure({ problem }, env);
      return 1;
    }
    const config = await loadConfig(repoDir);
    const workerDockerfile = join(repoDir, ".factory", "Dockerfile");
    const present = await access(workerDockerfile).then(
      () => true,
      () => false,
    );
    if (!present) {
      reportErr([{ kind: "fail", text: `${workerDockerfile} does not exist`, command: "factory init" }], env);
      return 1;
    }
    const ignored = dockerignoreProblem(await readDockerignore(repoDir));
    if (ignored !== null) {
      reportErr([{ kind: "fail", text: ignored.problem, command: ignored.fix }], env);
      return 1;
    }
    const outcome = await buildImages({ factoryRoot: env.factoryRoot, repoDir, image: config.image }, env.images);
    if (outcome.kind === "built" || outcome.kind === "worker-failed") {
      reportOut([{ kind: "ok", text: `built the base image ${BASE_IMAGE_TAG} (${shortId(outcome.baseImageId)})` }], env);
    }
    if (outcome.kind !== "built") {
      reportErr([{ kind: "fail", text: failure(outcome, config.image) }], env);
      return 1;
    }
    reportOut([{ kind: "ok", text: `built the worker image ${config.image}` }], env);
    return 0;
  } catch (error) {
    env.err(`factory: ${(error as Error).message}`);
    return 1;
  }
}
