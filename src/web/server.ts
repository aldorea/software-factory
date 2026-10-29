import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Clock } from "../coordinator/ports.ts";
import { handleRequest, TEXT } from "./handler.ts";
import { WEB_HOST } from "./host.ts";

export const DEFAULT_WEB_PORT = 7433;

export interface WebServer {
  host: string;
  port: number;
  close(): Promise<void>;
}

export interface WebServerOptions {
  repoDir: string;
  port: number;
  clock: Clock;
  idleTimeoutMs: number;
  err: (text: string) => void;
}

function pathOf(url: string | undefined): string {
  return (url ?? "/").split(/[?#]/, 1)[0] || "/";
}

async function respond(incoming: IncomingMessage, outgoing: ServerResponse, options: WebServerOptions, port: number): Promise<void> {
  try {
    const response = await handleRequest({
      method: incoming.method ?? "GET",
      path: pathOf(incoming.url),
      host: incoming.headers.host,
      repoDir: options.repoDir,
      port,
      now: options.clock.now(),
      idleTimeoutMs: options.idleTimeoutMs,
    });
    outgoing.writeHead(response.status, {
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
    const server = createServer((incoming, outgoing) => {
      void respond(incoming, outgoing, options, bound);
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
