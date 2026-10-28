import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Clock } from "../coordinator/ports.ts";
import { handleRequest } from "./handler.ts";

export const WEB_HOST = "127.0.0.1";
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
    });
    outgoing.writeHead(response.status, {
      "content-type": response.contentType,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    outgoing.end(response.body);
  } catch {
    outgoing.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
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
