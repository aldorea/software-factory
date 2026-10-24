#!/usr/bin/env node
import { join } from "node:path";
import { ghGitHub } from "../github/gh.ts";
import { runInteractive } from "./launch.ts";
import { main } from "./main.ts";
import { readProtectedPaths } from "./protected-paths.ts";

process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  factoryRoot: join(import.meta.dirname, "..", ".."),
  now: () => new Date(),
  github: (repoDir) => ghGitHub({ repoDir }),
  protectedPaths: readProtectedPaths,
  launch: runInteractive,
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});
