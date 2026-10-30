import { describe, expect, it } from "vitest";
import {
  BASE_IMAGE_LABEL,
  BASE_IMAGE_TAG,
  baseImageBuildArgs,
  buildImages,
  workerImageBuildArgs,
  type ImageDocker,
} from "../../src/workers/images.ts";

function fakeDocker(exitCodes: number[] = [], id: string | null = "sha256:base"): ImageDocker & { builds: string[][] } {
  const builds: string[][] = [];
  return {
    builds,
    user: { uid: 501, gid: 20 },
    build: async (args) => {
      builds.push(args);
      return exitCodes[builds.length - 1] ?? 0;
    },
    id: async () => id,
  };
}

const INPUT = {
  factoryRoot: "/factory",
  workerDockerfile: "/repo/.factory/Dockerfile",
  image: "toy-factory-worker:dev",
};

describe("baseImageBuildArgs", () => {
  it("should build the tag of the base image from the docker directory of the factory with the ids of the developer", () => {
    expect(baseImageBuildArgs({ factoryRoot: "/factory", tag: BASE_IMAGE_TAG, user: { uid: 501, gid: 20 } })).toEqual([
      "build",
      "-t",
      "software-factory/worker:dev",
      "--build-arg",
      "AGENT_UID=501",
      "--build-arg",
      "AGENT_GID=20",
      "/factory/docker",
    ]);
  });
});

describe("workerImageBuildArgs", () => {
  it("should build from the tag of the base image, since BuildKit cannot take an id in FROM, and label the worker image with its id", () => {
    expect(workerImageBuildArgs({ ...INPUT, baseTag: BASE_IMAGE_TAG, baseImageId: "sha256:abc" })).toEqual([
      "build",
      "-t",
      "toy-factory-worker:dev",
      "--build-arg",
      `BASE_IMAGE=${BASE_IMAGE_TAG}`,
      "--label",
      `${BASE_IMAGE_LABEL}=sha256:abc`,
      "-f",
      "/repo/.factory/Dockerfile",
      "/factory/docker",
    ]);
  });
});

describe("buildImages", () => {
  it("should build the base image first and the worker image second", async () => {
    const docker = fakeDocker();

    const outcome = await buildImages(INPUT, docker);

    expect(outcome).toEqual({ kind: "built", baseImageId: "sha256:base" });
    expect(docker.builds).toEqual([
      baseImageBuildArgs({ factoryRoot: "/factory", tag: BASE_IMAGE_TAG, user: docker.user }),
      workerImageBuildArgs({ ...INPUT, baseTag: BASE_IMAGE_TAG, baseImageId: "sha256:base" }),
    ]);
  });

  it("should not build the worker image when the base image fails", async () => {
    const docker = fakeDocker([3]);

    const outcome = await buildImages(INPUT, docker);

    expect(outcome).toEqual({ kind: "base-failed", exitCode: 3 });
    expect(docker.builds).toHaveLength(1);
  });

  it("should not build the worker image when the id of the base image cannot be read, since the label would be false", async () => {
    const docker = fakeDocker([], null);

    const outcome = await buildImages(INPUT, docker);

    expect(outcome).toEqual({ kind: "base-unreadable" });
    expect(docker.builds).toHaveLength(1);
  });

  it("should report the failure of the worker image after the base image was built", async () => {
    const docker = fakeDocker([0, 2]);

    const outcome = await buildImages(INPUT, docker);

    expect(outcome).toEqual({ kind: "worker-failed", baseImageId: "sha256:base", exitCode: 2 });
  });
});
