import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dockerImages } from "../../src/workers/docker-images.ts";
import { BASE_IMAGE_LABEL, buildImages } from "../../src/workers/images.ts";
import { exec, execOk } from "../../src/workers/sh.ts";
import { tempDirs } from "../temp-dirs.ts";

const SUFFIX = `${process.pid}-${Date.now()}`;
const BASE_TAG = `software-factory/test-base:${SUFFIX}`;
const WORKER_TAG = `software-factory/test-worker:${SUFFIX}`;

const temp = tempDirs();
afterEach(async () => {
  await exec("docker", ["rmi", "--force", WORKER_TAG, BASE_TAG]);
  await temp.removeAll();
});

describe.skipIf(!process.env.FACTORY_DOCKER_TESTS)("buildImages", { timeout: 120_000 }, () => {
  it("should label the worker image with the id of the base image it was built from, with no subscription", async () => {
    const factoryRoot = await temp.make("images-factory-");
    await mkdir(join(factoryRoot, "docker"));
    await writeFile(join(factoryRoot, "docker", "Dockerfile"), "FROM scratch\nARG AGENT_UID=1000\nARG AGENT_GID=1000\nLABEL test.uid=${AGENT_UID}\n");
    const repoDir = await temp.make("images-repo-");
    await mkdir(join(repoDir, ".factory"));
    const workerDockerfile = join(repoDir, ".factory", "Dockerfile");
    await writeFile(workerDockerfile, "ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n");
    const docker = dockerImages({ user: { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 }, output: "ignore" });

    const outcome = await buildImages({ factoryRoot, workerDockerfile, image: WORKER_TAG, baseTag: BASE_TAG }, docker);

    expect(outcome.kind).toBe("built");
    const baseId = (await execOk("docker", ["image", "inspect", "--format", "{{.Id}}", BASE_TAG])).trim();
    const label = (
      await execOk("docker", ["image", "inspect", "--format", `{{ index .Config.Labels "${BASE_IMAGE_LABEL}" }}`, WORKER_TAG])
    ).trim();
    expect(label).toBe(baseId);
    const uid = (await execOk("docker", ["image", "inspect", "--format", '{{ index .Config.Labels "test.uid" }}', BASE_TAG])).trim();
    expect(uid).toBe(String(process.getuid?.() ?? 1000));
  });
});
