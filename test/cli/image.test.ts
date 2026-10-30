import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, type CliEnv } from "../../src/cli/main.ts";
import { BASE_IMAGE_LABEL, BASE_IMAGE_TAG } from "../../src/workers/images.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeGitHub } from "../fakes/github.ts";
import { FakeImageDocker } from "../fakes/image-docker.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeVerifier } from "../fakes/verifier.ts";
import { FakeWorkerRunner } from "../fakes/worker-runner.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

const CONFIG = `export default {
  image: "toy-factory-worker:dev",
  checks: [{ name: "spec", command: "true" }],
  evidence: {},
  environment: () => ({}),
  protectedPaths: [],
};
`;

async function targetRepo(options: { dockerfile?: boolean } = {}): Promise<string> {
  const dir = await temp.make("cli-image-");
  await mkdir(join(dir, ".factory"));
  await writeFile(join(dir, ".factory", "config.ts"), CONFIG);
  if (options.dockerfile !== false) await writeFile(join(dir, ".factory", "Dockerfile"), "FROM scratch\n");
  return dir;
}

function cli(cwd: string, images: FakeImageDocker, overrides: Partial<CliEnv> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const env: CliEnv = {
    cwd,
    factoryRoot: "/factory",
    clock: new FakeClock("2026-10-24T08:00:00.000Z"),
    github: () => new FakeGitHub([]),
    runner: () => new FakeWorkerRunner(),
    verifier: () => new FakeVerifier(),
    notifier: new FakeNotifier(),
    credentials: {},
    docker: async () => null,
    gh: async () => null,
    launch: async () => 0,
    images,
    signal: new AbortController().signal,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    ...overrides,
  };
  return { env, out, err };
}

describe("factory image", () => {
  it("should build the base image and then the worker image of the config, labelled with the base image id", async () => {
    const repoDir = await targetRepo();
    const images = new FakeImageDocker();
    const { env, out } = cli(repoDir, images);

    const code = await main(["image"], env);

    expect(code).toBe(0);
    expect(images.builds).toEqual([
      [
        "build",
        "-t",
        BASE_IMAGE_TAG,
        "--build-arg",
        "AGENT_UID=501",
        "--build-arg",
        "AGENT_GID=20",
        "/factory/docker",
      ],
      [
        "build",
        "-t",
        "toy-factory-worker:dev",
        "--build-arg",
        `BASE_IMAGE=${BASE_IMAGE_TAG}`,
        "--label",
        `${BASE_IMAGE_LABEL}=sha256:0123456789abcdef0123456789abcdef`,
        "-f",
        join(repoDir, ".factory", "Dockerfile"),
        "/factory/docker",
      ],
    ]);
    expect(out).toEqual([
      `✓ built the base image ${BASE_IMAGE_TAG} (sha256:0123456789ab)`,
      "✓ built the worker image toy-factory-worker:dev",
    ]);
  });

  it("should build for the target repo that is passed as an argument", async () => {
    const repoDir = await targetRepo();
    const images = new FakeImageDocker();
    const { env } = cli("/elsewhere", images);

    const code = await main(["image", repoDir], env);

    expect(code).toBe(0);
    expect(images.builds[1]).toContain("toy-factory-worker:dev");
  });

  it("should colour the output only when the environment asks for it", async () => {
    const images = new FakeImageDocker();
    const { env, out } = cli(await targetRepo(), images, { color: true });

    await main(["image"], env);

    expect(out[0]).toContain(`${String.fromCharCode(27)}[1;92m✓`);
  });

  it("should exit with an error and not build the worker image when the base image fails", async () => {
    const images = new FakeImageDocker([1]);
    const { env, out, err } = cli(await targetRepo(), images);

    const code = await main(["image"], env);

    expect(code).toBe(1);
    expect(images.builds).toHaveLength(1);
    expect(out).toEqual([]);
    expect(err).toEqual([`✗ the base image ${BASE_IMAGE_TAG} failed to build (docker exit code 1)`]);
  });

  it("should exit with an error when the worker image fails, after the base image was built", async () => {
    const images = new FakeImageDocker([0, 2]);
    const { env, out, err } = cli(await targetRepo(), images);

    const code = await main(["image"], env);

    expect(code).toBe(1);
    expect(out).toHaveLength(1);
    expect(err).toEqual(["✗ the worker image toy-factory-worker:dev failed to build (docker exit code 2)"]);
  });

  it("should not build the worker image when the id of the base image cannot be read", async () => {
    const images = new FakeImageDocker([], null);
    const { env, err } = cli(await targetRepo(), images);

    const code = await main(["image"], env);

    expect(code).toBe(1);
    expect(images.builds).toHaveLength(1);
    expect(err[0]).toContain("could not read the id of the base image");
  });

  it("should not build anything when the repo has no .factory/Dockerfile, and point to factory init", async () => {
    const images = new FakeImageDocker();
    const { env, err } = cli(await targetRepo({ dockerfile: false }), images);

    const code = await main(["image"], env);

    expect(code).toBe(1);
    expect(images.builds).toEqual([]);
    expect(err.join("\n")).toContain("factory init");
  });

  it("should not build anything when Docker is not running", async () => {
    const images = new FakeImageDocker();
    const { env, err } = cli(await targetRepo(), images, { docker: async () => "Docker is not running" });

    const code = await main(["image"], env);

    expect(code).toBe(1);
    expect(images.builds).toEqual([]);
    expect(err).toEqual(["✗ factory: Docker is not running"]);
  });

  it("should refuse the factory itself as the target repo and not build", async () => {
    const repoDir = await targetRepo();
    const images = new FakeImageDocker();
    const { env, err } = cli(repoDir, images, { factoryRoot: repoDir });

    const code = await main(["image"], env);

    expect(code).toBe(1);
    expect(images.builds).toEqual([]);
    expect(err[0]).toContain("is the factory itself");
  });

  it("should print the usage and exit 2 when it gets more than one target repo", async () => {
    const images = new FakeImageDocker();
    const { env, err } = cli("/elsewhere", images);

    const code = await main(["image", "a", "b"], env);

    expect(code).toBe(2);
    expect(err[0]).toContain("factory image");
  });
});
