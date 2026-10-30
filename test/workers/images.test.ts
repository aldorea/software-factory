import { describe, expect, it } from "vitest";
import {
  BASE_IMAGE_LABEL,
  BASE_IMAGE_TAG,
  baseImageBuildArgs,
  buildImages,
  readWorkerImageFacts,
  workerImageBuildArgs,
  workerImageState,
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
    label: async () => id,
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

describe("workerImageState", () => {
  const BASE = "sha256:base-now";

  it("should be missing when the worker image does not exist", () => {
    expect(workerImageState({ baseImageId: BASE, workerImageId: null, workerLabel: null })).toBe("missing");
  });

  it("should be base-missing when the base image does not exist, because no worker image can then be current", () => {
    expect(workerImageState({ baseImageId: null, workerImageId: "sha256:w", workerLabel: BASE })).toBe("base-missing");
  });

  it("should be unlabelled when the worker image has no label, as when it was built by hand", () => {
    expect(workerImageState({ baseImageId: BASE, workerImageId: "sha256:w", workerLabel: null })).toBe("unlabelled");
  });

  it("should be stale when the label holds the id of an older base image", () => {
    expect(workerImageState({ baseImageId: BASE, workerImageId: "sha256:w", workerLabel: "sha256:base-old" })).toBe("stale");
  });

  it("should be current when the label holds the id of the current base image", () => {
    expect(workerImageState({ baseImageId: BASE, workerImageId: "sha256:w", workerLabel: BASE })).toBe("current");
  });
});

describe("readWorkerImageFacts", () => {
  it("should read the ids of both images and the label of the worker image through the port", async () => {
    const docker = fakeDocker([], "sha256:base");
    docker.label = async (reference, name) => (reference === "toy:dev" && name === BASE_IMAGE_LABEL ? "sha256:old" : null);

    expect(await readWorkerImageFacts("toy:dev", docker)).toEqual({
      baseImageId: "sha256:base",
      workerImageId: "sha256:base",
      workerLabel: "sha256:old",
    });
  });

  it("should not read the label of a worker image that does not exist", async () => {
    const docker = fakeDocker([], "sha256:base");
    docker.id = async (reference) => (reference === BASE_IMAGE_TAG ? "sha256:base" : null);
    docker.label = async () => {
      throw new Error("label read of a missing image");
    };

    expect((await readWorkerImageFacts("toy:dev", docker)).workerLabel).toBeNull();
  });
});
