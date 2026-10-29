#!/usr/bin/env node
import { join } from "node:path";
import { CREDENTIAL_VARIABLES } from "../config/roles.ts";
import { configuredVerifier } from "../coordinator/docker-verifier.ts";
import { ghGitHub, ghProblem } from "../github/gh.ts";
import { macosNotifier } from "../notify/macos.ts";
import { AGENT_KINDS } from "../workers/agents.ts";
import { DockerWorkerRunner } from "../workers/docker-runner.ts";
import { dockerProblem } from "../workers/docker.ts";
import { askRolesInTerminal } from "./ask-role.ts";
import { launchInteractive } from "./launch.ts";
import { main } from "./main.ts";
import { CLEAR_LINE } from "./terminal-render.ts";

const clock = { now: () => new Date() };

const stop = new AbortController();
if (process.argv[2] === "web") {
  process.once("SIGINT", () => stop.abort());
  process.once("SIGTERM", () => stop.abort());
}

const terminal =
  process.stdout.isTTY && process.stdin.isTTY
    ? { columns: () => process.stdout.columns || 80, write: (text: string) => void process.stdout.write(text) }
    : undefined;
if (process.argv[2] === "run" && terminal) {
  process.once("SIGINT", () => {
    terminal.write(CLEAR_LINE);
    process.exit(130);
  });
}

const credentials = Object.fromEntries(
  AGENT_KINDS.flatMap((kind) => {
    const value = process.env[CREDENTIAL_VARIABLES[kind]];
    return value ? [[kind, value]] : [];
  }),
);

process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  factoryRoot: join(import.meta.dirname, "..", ".."),
  clock,
  github: (repoDir) => ghGitHub({ repoDir }),
  runner: () => new DockerWorkerRunner(),
  verifier: (config, role) => configuredVerifier(config, role, credentials, clock),
  notifier: macosNotifier(),
  credentials,
  docker: () => dockerProblem(),
  gh: () => ghProblem(),
  ...(process.stdin.isTTY && process.stdout.isTTY ? { ask: askRolesInTerminal } : {}),
  ...(terminal ? { terminal } : {}),
  launch: launchInteractive,
  signal: stop.signal,
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});
