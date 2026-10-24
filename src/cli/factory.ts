#!/usr/bin/env node
import { ghGitHub } from "../github/gh.ts";
import { main } from "./main.ts";
import { readProtectedPaths } from "./protected-paths.ts";

process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  now: () => new Date(),
  github: (repoDir) => ghGitHub({ repoDir }),
  protectedPaths: readProtectedPaths,
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});
