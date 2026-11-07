import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Clock } from "../coordinator/ports.ts";
import { handleRequest, TEXT } from "./handler.ts";
import { WEB_HOST } from "./host.ts";
import { launchWebAction, stopWebAction } from "./launcher.ts";
import { processStartTime } from "./process-start.ts";
import { newToken } from "./token.ts";

export const DEFAULT_WEB_PORT = 7433;

const FACTORY_BIN = join(import.meta.dirname, "..", "cli", "factory.ts");
const MAX_BODY = 64 * 1024;

export interface WebServer {
  host: string;
  port: number;
  close(): Promise<void>;
}

export interface WebServerOptions {
  repoDir: string;
  clientDir: string;
  port: number;
  token?: string;
  clock: Clock;
  err: (text: string) => void;
}

function pathOf(url: string | undefined): string {
  return (url ?? "/").split(/[?#]/, 1)[0] || "/";
}

function queryOf(url: string | undefined): string {
  const query = (url ?? "").split("#", 1)[0] ?? "";
  const index = query.indexOf("?");
  return index === -1 ? "" : query.slice(index + 1);
}

function bodyOf(incoming: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("the body is too large"));
        incoming.destroy();
      } else chunks.push(chunk);
    });
    incoming.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    incoming.once("error", reject);
  });
}

async function respond(incoming: IncomingMessage, outgoing: ServerResponse, options: WebServerOptions, port: number, token: string): Promise<void> {
  try {
    const method = incoming.method ?? "GET";
    const now = options.clock.now();
    const response = await handleRequest({
      method,
      path: pathOf(incoming.url),
      query: queryOf(incoming.url),
      host: incoming.headers.host,
      origin: incoming.headers.origin,
      cookie: incoming.headers.cookie,
      body: method === "POST" ? await bodyOf(incoming) : "",
      token,
      repoDir: options.repoDir,
      clientDir: options.clientDir,
      port,
      now,
      processStart: processStartTime,
    });
    if (response.start !== undefined) {
      await launchWebAction({ repoDir: options.repoDir, factoryBin: FACTORY_BIN, start: response.start, now });
    }
    if (response.stop !== undefined && !(await stopWebAction(response.stop))) {
      outgoing.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      outgoing.end(JSON.stringify({ error: "the web action is not working: there is nothing to stop" }));
      return;
    }
    outgoing.writeHead(response.status, {
      ...response.headers,
      "content-type": response.contentType,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    outgoing.end(response.body);
  } catch (error) {
    options.err(`factory web: ${incoming.method ?? "GET"} ${pathOf(incoming.url)} failed: ${error instanceof Error ? error.message : String(error)}`);
    outgoing.writeHead(500, { "content-type": TEXT });
    outgoing.end("internal error");
  }
}

export function startWebServer(options: WebServerOptions): Promise<WebServer> {
  return new Promise((resolve, reject) => {
    let bound = options.port;
    const token = options.token ?? newToken();
    const server = createServer((incoming, outgoing) => {
      void respond(incoming, outgoing, options, bound, token);
    });
    server.once("error", reject);
    server.listen(options.port, WEB_HOST, () => {
      server.off("error", reject);
      bound = (server.address() as AddressInfo).port;
      resolve({
        host: WEB_HOST,
        port: bound,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
