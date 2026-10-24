#!/usr/bin/env node
import { join } from "node:path";
import { CREDENTIAL_VARIABLES } from "../coordinator/run.ts";
import { ghGitHub } from "../github/gh.ts";
import { macosNotifier } from "../notify/macos.ts";
import { AGENT_KINDS } from "../workers/agents.ts";
import { DockerWorkerRunner } from "../workers/docker-runner.ts";
import { runInteractive } from "./launch.ts";
import { main } from "./main.ts";

process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  factoryRoot: join(import.meta.dirname, "..", ".."),
  clock: { now: () => new Date() },
  github: (repoDir) => ghGitHub({ repoDir }),
  runner: () => new DockerWorkerRunner(),
  notifier: macosNotifier(),
  credentials: Object.fromEntries(
    AGENT_KINDS.flatMap((kind) => {
      const value = process.env[CREDENTIAL_VARIABLES[kind]];
      return value ? [[kind, value]] : [];
    }),
  ),
  launch: runInteractive,
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});
