import { join } from "node:path";

export const BASE_IMAGE_TAG = "software-factory/worker:dev";
export const BASE_IMAGE_LABEL = "software-factory.base-image-id";

export interface ImageDocker {
  user: { uid: number; gid: number };
  build(args: string[]): Promise<number>;
  id(reference: string): Promise<string | null>;
}

export type ImageBuildOutcome =
  | { kind: "built"; baseImageId: string }
  | { kind: "base-failed"; exitCode: number }
  | { kind: "base-unreadable" }
  | { kind: "worker-failed"; baseImageId: string; exitCode: number };

export interface ImageBuildInput {
  factoryRoot: string;
  workerDockerfile: string;
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
  factoryRoot: string;
  workerDockerfile: string;
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
    input.workerDockerfile,
    join(input.factoryRoot, "docker"),
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
