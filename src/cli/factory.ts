#!/usr/bin/env node
import { join } from "node:path";
import { CREDENTIAL_VARIABLES } from "../config/roles.ts";
import { configuredVerifier } from "../coordinator/docker-verifier.ts";
import { ghGitHub } from "../github/gh.ts";
import { macosNotifier } from "../notify/macos.ts";
import { AGENT_KINDS } from "../workers/agents.ts";
import { DockerWorkerRunner } from "../workers/docker-runner.ts";
import { askRoleInTerminal } from "./ask-role.ts";
import { runInteractive } from "./launch.ts";
import { main } from "./main.ts";

const credentials = Object.fromEntries(
  AGENT_KINDS.flatMap((kind) => {
    const value = process.env[CREDENTIAL_VARIABLES[kind]];
    return value ? [[kind, value]] : [];
  }),
);

process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  factoryRoot: join(import.meta.dirname, "..", ".."),
  clock: { now: () => new Date() },
  github: (repoDir) => ghGitHub({ repoDir }),
  runner: () => new DockerWorkerRunner(),
  verifier: (repoDir, role) => configuredVerifier(repoDir, role, credentials),
  notifier: macosNotifier(),
  credentials,
  ...(process.stdin.isTTY && process.stdout.isTTY ? { ask: askRoleInTerminal } : {}),
  launch: runInteractive,
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});
