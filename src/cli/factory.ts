#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { credentialsFilePath, resolveCredentials } from "../config/credentials.ts";
import { loadCredentials } from "../config/credentials-store.ts";
import { configuredVerifier } from "../coordinator/docker-verifier.ts";
import { originHeadProblem } from "../git/repo.ts";
import { ghGitHub, ghProblem } from "../github/gh.ts";
import { macosNotifier } from "../notify/macos.ts";
import { claudeSessionProblem } from "../workers/claude-session.ts";
import { DockerWorkerRunner } from "../workers/docker-runner.ts";
import { dockerProblem } from "../workers/docker.ts";
import { dockerImages } from "../workers/docker-images.ts";
import { askRolesInTerminal } from "./ask-role.ts";
import { terminalMenuScreen } from "./auth-screen.ts";
import { launchInteractive } from "./launch.ts";
import { main } from "./main.ts";
import { confirmInTerminal, readLineFromStdin, readSecretInTerminal } from "./secret-input.ts";
import { colorEnabled, renderSetup } from "./setup-render.ts";
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

const credentialsPath = credentialsFilePath(process.env, homedir());
const color = colorEnabled({ stdout: features.screen, noColor: process.env.NO_COLOR });
const command = process.argv[2];
const loaded =
  command === "run" || command === "init"
    ? await loadCredentials(credentialsPath, process.env)
    : { ok: true as const, credentials: resolveCredentials(process.env, {}) };
if (!loaded.ok && command !== "init") {
  for (const line of renderSetup([{ kind: "fail", text: `factory: ${loaded.problem}` }], color)) {
    process.stderr.write(`${line}\n`);
  }
  process.exit(1);
}
const credentials = loaded.ok ? loaded.credentials : resolveCredentials(process.env, {});

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
  auth: {
    credentialsPath,
    environment: process.env,
    terminal: features.menu,
    ...(features.menu ? { screen: terminalMenuScreen() } : {}),
    readSecret: (prompt) => (features.menu ? readSecretInTerminal(prompt) : readLineFromStdin()),
    confirm: confirmInTerminal,
  },
  color,
  ...(terminal ? { terminal } : {}),
  launch: launchInteractive,
  images: dockerImages({ user: { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 } }),
  signal: stop.signal,
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});
