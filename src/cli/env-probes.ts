import { loadConfig } from "../config/load.ts";
import type { CliEnv } from "./main.ts";
import { nodeProblemOf } from "./node-probe.ts";
import type { Probes } from "./readiness.ts";
import { workerImageProblem } from "./worker-image-probe.ts";

export function envProbes(repoDir: string, env: CliEnv, image: string | null = null): Probes {
  return {
    docker: () => env.docker(),
    gh: () => env.gh(),
    claudeSession: () => env.claudeSession(),
    originHead: () => env.originHead(repoDir),
    workerImage: () => workerImageProblem(image, env.images),
    node: () => nodeProblemOf(env.factoryRoot, process.versions.node),
    config: () => loadConfig(repoDir).then(() => null, (error: unknown) => (error as Error).message),
  };
}
