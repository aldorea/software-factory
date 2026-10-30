#!/usr/bin/env node
import { join } from "node:path";
import { CREDENTIAL_VARIABLES } from "../config/roles.ts";
import { configuredVerifier } from "../coordinator/docker-verifier.ts";
import { originHeadProblem } from "../git/repo.ts";
import { ghGitHub, ghProblem } from "../github/gh.ts";
import { macosNotifier } from "../notify/macos.ts";
import { AGENT_KINDS } from "../workers/agents.ts";
import { claudeSessionProblem } from "../workers/claude-session.ts";
import { DockerWorkerRunner } from "../workers/docker-runner.ts";
import { dockerProblem } from "../workers/docker.ts";
import { askRolesInTerminal } from "./ask-role.ts";
import { launchInteractive } from "./launch.ts";
import { main } from "./main.ts";
import { colorEnabled } from "./setup-render.ts";
import { CLEAR_LINE } from "./terminal-render.ts";
import { terminalFeatures } from "./tty.ts";

const clock = { now: () => new Date() };

const stop = new AbortController();
if (process.argv[2] === "web") {
  process.once("SIGINT", () => stop.abort());
  process.once("SIGTERM", () => stop.abort());
}

const features = terminalFeatures({ stdout: Boolean(process.stdout.isTTY), stdin: Boolean(process.stdin.isTTY) });
const terminal =
  features.screen
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
  claudeSession: () => claudeSessionProblem(),
  originHead: (repoDir) => originHeadProblem(repoDir),
  ...(features.menu ? { ask: askRolesInTerminal } : {}),
  color: colorEnabled({ stdout: features.screen, noColor: process.env.NO_COLOR }),
  ...(terminal ? { terminal } : {}),
  launch: launchInteractive,
  signal: stop.signal,
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});
