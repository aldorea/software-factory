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
import { reportFailure } from "./report.ts";
import { colorEnabled } from "./setup-render.ts";
import { CLEAR_LINE } from "./terminal-render.ts";
import { hidesSecret, terminalFeatures } from "./tty.ts";

const clock = { now: () => new Date() };

const stop = new AbortController();
if (process.argv[2] === "web") {
  process.once("SIGINT", () => stop.abort());
  process.once("SIGTERM", () => stop.abort());
}

const stdoutIsTerminal = Boolean(process.stdout.isTTY);
const stdinIsTerminal = Boolean(process.stdin.isTTY);
const features = terminalFeatures({ stdout: stdoutIsTerminal, stdin: stdinIsTerminal });
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
const color = colorEnabled({ tty: stdoutIsTerminal, noColor: process.env.NO_COLOR });
const errColor = colorEnabled({ tty: Boolean(process.stderr.isTTY), noColor: process.env.NO_COLOR });
const err = (text: string) => void process.stderr.write(`${text}\n`);
const command = process.argv[2] ?? "";
const CREDENTIALS_FILE = new Map([
  ["run", "required"],
  ["init", "tolerated"],
  ["doctor", "tolerated"],
]);
const loaded = CREDENTIALS_FILE.has(command)
  ? await loadCredentials(credentialsPath, process.env)
  : { ok: true as const, credentials: resolveCredentials(process.env, {}) };
if (!loaded.ok && CREDENTIALS_FILE.get(command) === "required") {
  reportFailure(loaded, { out: () => undefined, err, errColor });
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
  ...(loaded.ok ? {} : { credentialsProblem: loaded }),
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
    readSecret: (prompt) => (hidesSecret({ stdin: stdinIsTerminal }) ? readSecretInTerminal(prompt) : readLineFromStdin()),
    confirm: confirmInTerminal,
  },
  color,
  errColor,
  ...(terminal ? { terminal } : {}),
  launch: launchInteractive,
  images: dockerImages({ user: { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 } }),
  signal: stop.signal,
  out: (text) => process.stdout.write(`${text}\n`),
  err,
});
