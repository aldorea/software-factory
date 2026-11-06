// PROTOTYPE (throwaway, branch prototype/web-react-live): read-only JSON API over node:http, plus Vite in dev or dist/web when --built.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveWorld } from "./live-data.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const args = process.argv.slice(2);
const repoDir = resolve(args.find((arg) => !arg.startsWith("--")) ?? join(here, "../../../../askwell"));
const built = args.includes("--built");
const API_PORT = 7435;
const distDir = resolve(here, "../../../dist/web");

const world = new LiveWorld(repoDir, Date.now());
await world.load();

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

const server = createServer(async (request, response) => {
  const path = (request.url ?? "/").split("?")[0] ?? "/";
  const json = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  };
  const now = Date.now();
  if (path === "/api/live") return json(200, await world.live(now));
  if (path === "/api/runs") return json(200, await world.runs(now));
  const match = /^\/api\/runs\/([^/]+)$/.exec(path);
  if (match !== null) {
    const detail = await world.run(decodeURIComponent(match[1]!), now);
    return detail === null ? json(404, { error: "not found" }) : json(200, detail);
  }
  if (path.startsWith("/api/")) return json(404, { error: "not found" });
  if (!built) {
    response.writeHead(404);
    return response.end();
  }
  const file = resolve(distDir, `.${path}`);
  const isFile = file.startsWith(distDir) && (await stat(file).catch(() => null))?.isFile() === true;
  const target = isFile ? file : join(distDir, "index.html");
  response.writeHead(200, { "content-type": TYPES[extname(target)] ?? "application/octet-stream" });
  response.end(await readFile(target));
});

server.listen(API_PORT, "127.0.0.1");

if (built) {
  console.log(`PROTOTYPE factory web (built bundle) on http://127.0.0.1:${API_PORT}/live  — repo ${repoDir}`);
} else {
  const { createServer: createVite } = await import("vite");
  const vite = await createVite({ configFile: join(here, "vite.config.ts") });
  await vite.listen();
  console.log(`PROTOTYPE factory web (vite dev) on http://127.0.0.1:${vite.config.server.port}/live?variant=A  — API :${API_PORT}, repo ${repoDir}`);
}
