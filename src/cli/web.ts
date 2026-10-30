import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_WEB_PORT, startWebServer } from "../web/server.ts";
import type { CliEnv } from "./main.ts";
import { refused } from "./target-repo.ts";

export const WEB_USAGE = "factory web [target-repo] [--port <port>]";

type WebEnv = Pick<CliEnv, "cwd" | "factoryRoot" | "clock" | "signal" | "out" | "err">;

interface WebArgs {
  repoArg?: string;
  port: number;
}

function parseWebArgs(args: string[]): WebArgs | null {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: { port: { type: "string" } } });
  } catch {
    return null;
  }
  if (parsed.positionals.length > 1) return null;
  const portArg = parsed.values.port;
  const port = portArg === undefined ? DEFAULT_WEB_PORT : Number(portArg);
  if (!/^\d+$/.test(portArg ?? "0") || port > 65535) return null;
  const repoArg = parsed.positionals[0];
  return { port, ...(repoArg !== undefined ? { repoArg } : {}) };
}

function stopped(signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal.aborted) done();
    else signal.addEventListener("abort", () => done(), { once: true });
  });
}

export async function web(args: string[], env: WebEnv, usage: string): Promise<number> {
  const parsed = parseWebArgs(args);
  if (parsed === null) {
    env.err(usage);
    return 2;
  }
  const repoDir = resolve(env.cwd, parsed.repoArg ?? ".");
  if (await refused(repoDir, env)) return 1;
  let server;
  try {
    server = await startWebServer({
      repoDir,
      port: parsed.port,
      clock: env.clock,
      err: env.err,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    env.err(
      code === "EADDRINUSE"
        ? `factory: port ${parsed.port} is already in use; choose another with --port`
        : `factory: ${(error as Error).message}`,
    );
    return 1;
  }
  env.out(`factory web: http://${server.host}:${server.port}/ (Ctrl-C to stop)`);
  await stopped(env.signal);
  await server.close();
  return 0;
}
