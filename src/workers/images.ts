import { join } from "node:path";

const FACTORY_DIR = ".factory";
export const BASE_IMAGE_TAG = "software-factory/worker:dev";
export const BASE_IMAGE_LABEL = "software-factory.base-image-id";

export interface ImageDocker {
  user: { uid: number; gid: number };
  build(args: string[]): Promise<number>;
  id(reference: string): Promise<string | null>;
  label(reference: string, name: string): Promise<string | null>;
}

export interface WorkerImageFacts {
  baseImageId: string | null;
  workerImageId: string | null;
  workerLabel: string | null;
}

export type WorkerImageState = "missing" | "base-missing" | "unlabelled" | "stale" | "current";

export function workerImageState(facts: WorkerImageFacts): WorkerImageState {
  if (facts.workerImageId === null) return "missing";
  if (facts.baseImageId === null) return "base-missing";
  if (facts.workerLabel === null) return "unlabelled";
  return facts.workerLabel === facts.baseImageId ? "current" : "stale";
}

export async function readWorkerImageFacts(
  image: string,
  docker: ImageDocker,
  baseTag: string = BASE_IMAGE_TAG,
): Promise<WorkerImageFacts> {
  const [baseImageId, workerImageId] = await Promise.all([docker.id(baseTag), docker.id(image)]);
  const workerLabel = workerImageId === null ? null : await docker.label(image, BASE_IMAGE_LABEL);
  return { baseImageId, workerImageId, workerLabel };
}

export type ImageBuildOutcome =
  | { kind: "built"; baseImageId: string }
  | { kind: "base-failed"; exitCode: number }
  | { kind: "base-unreadable" }
  | { kind: "worker-failed"; baseImageId: string; exitCode: number };

export interface ImageBuildInput {
  factoryRoot: string;
  repoDir: string;
  image: string;
  baseTag?: string;
}

export function baseImageBuildArgs(input: {
  factoryRoot: string;
  tag: string;
  user: { uid: number; gid: number };
}): string[] {
  return [
    "build",
    "-t",
    input.tag,
    "--build-arg",
    `AGENT_UID=${input.user.uid}`,
    "--build-arg",
    `AGENT_GID=${input.user.gid}`,
    join(input.factoryRoot, "docker"),
  ];
}

export function workerImageBuildArgs(input: {
  repoDir: string;
  image: string;
  baseTag: string;
  baseImageId: string;
}): string[] {
  return [
    "build",
    "-t",
    input.image,
    "--build-arg",
    `BASE_IMAGE=${input.baseTag}`,
    "--label",
    `${BASE_IMAGE_LABEL}=${input.baseImageId}`,
    "-f",
    join(input.repoDir, FACTORY_DIR, "Dockerfile"),
    join(input.repoDir, FACTORY_DIR),
  ];
}

export async function buildImages(input: ImageBuildInput, docker: ImageDocker): Promise<ImageBuildOutcome> {
  const baseTag = input.baseTag ?? BASE_IMAGE_TAG;
  const baseExit = await docker.build(
    baseImageBuildArgs({ factoryRoot: input.factoryRoot, tag: baseTag, user: docker.user }),
  );
  if (baseExit !== 0) return { kind: "base-failed", exitCode: baseExit };
  const baseImageId = await docker.id(baseTag);
  if (baseImageId === null) return { kind: "base-unreadable" };
  const workerExit = await docker.build(workerImageBuildArgs({ ...input, baseTag, baseImageId }));
  if (workerExit !== 0) return { kind: "worker-failed", baseImageId, exitCode: workerExit };
  return { kind: "built", baseImageId };
}
