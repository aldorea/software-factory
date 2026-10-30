import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/load.ts";
import { BASE_IMAGE_TAG, buildImages, type ImageBuildOutcome } from "../workers/images.ts";
import type { CliEnv } from "./main.ts";
import { renderSetup, type SetupLine } from "./setup-render.ts";
import { refused } from "./target-repo.ts";

const ID_DIGITS = 12;

function show(lines: SetupLine[], write: (text: string) => void, color: boolean): void {
  for (const line of renderSetup(lines, color)) write(line);
}

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
  const color = env.color === true;
  try {
    const problem = await env.docker();
    if (problem !== null) {
      show([{ kind: "fail", text: `factory: ${problem}` }], env.err, color);
      return 1;
    }
    const config = await loadConfig(repoDir);
    const workerDockerfile = join(repoDir, ".factory", "Dockerfile");
    const present = await access(workerDockerfile).then(
      () => true,
      () => false,
    );
    if (!present) {
      show([{ kind: "fail", text: `${workerDockerfile} does not exist`, command: "factory init" }], env.err, color);
      return 1;
    }
    const outcome = await buildImages({ factoryRoot: env.factoryRoot, workerDockerfile, image: config.image }, env.images);
    if (outcome.kind === "built" || outcome.kind === "worker-failed") {
      show(
        [{ kind: "ok", text: `built the base image ${BASE_IMAGE_TAG} (${shortId(outcome.baseImageId)})` }],
        env.out,
        color,
      );
    }
    if (outcome.kind !== "built") {
      show([{ kind: "fail", text: failure(outcome, config.image) }], env.err, color);
      return 1;
    }
    show([{ kind: "ok", text: `built the worker image ${config.image}` }], env.out, color);
    return 0;
  } catch (error) {
    env.err(`factory: ${(error as Error).message}`);
    return 1;
  }
}
