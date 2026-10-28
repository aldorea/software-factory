import { RELOAD_SECONDS } from "./reload.ts";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] as string);
}

export function safeLink(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

export function link(href: string, text: string): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
}

export function anchor(url: string, text: string): string {
  const href = safeLink(url);
  return href === null ? escapeHtml(text) : link(href, text);
}

export const RAW_LOG = "Log crudo";
export const FULL_OUTPUT = "Salida completa";

export function logAnchors(url: string | null, text: string): string[] {
  return url === null ? [] : [link(url, text)];
}

export function bullets(items: readonly string[]): string {
  return ["<ul>", ...items, "</ul>"].join("\n");
}

export function titledList(level: "h2" | "h3" | "h4", heading: string, items: readonly string[]): string {
  return [`<${level}>${escapeHtml(heading)}</${level}>`, bullets(items)].join("\n");
}

const TONES = new Map<string, string>([
  ["ready", "ok"],
  ["merged", "ok"],
  ["pasa", "ok"],
  ["aceptado", "ok"],
  ["accept", "ok"],
  ["draft", "warn"],
  ["interrupted", "warn"],
  ["paused", "info"],
  ["running", "info"],
  ["working", "info"],
  ["gating", "info"],
  ["blocked", "bad"],
  ["falla", "bad"],
  ["rechazado", "bad"],
  ["refute", "bad"],
  ["error", "bad"],
]);

export function badge(value: string): string {
  return `<span class="badge ${TONES.get(value) ?? "muted"}">${escapeHtml(value)}</span>`;
}

const STYLE = [
  ":root{color-scheme:light dark;--bg:#fafaf9;--card:#fff;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--accent:#2563eb;--ok:#15803d;--ok-bg:#dcfce7;--warn:#a16207;--warn-bg:#fef3c7;--bad:#b91c1c;--bad-bg:#fee2e2;--info:#1d4ed8;--info-bg:#dbeafe;--muted-bg:#f5f5f4}",
  "@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--card:#1c1917;--fg:#e7e5e4;--muted:#a8a29e;--line:#292524;--accent:#60a5fa;--ok:#4ade80;--ok-bg:#14532d66;--warn:#facc15;--warn-bg:#713f1266;--bad:#f87171;--bad-bg:#7f1d1d66;--info:#93c5fd;--info-bg:#1e3a8a66;--muted-bg:#292524}}",
  "body{background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,sans-serif;margin:2.5rem auto;max-width:60rem;padding:0 1rem}",
  "h1{font-size:1.6rem;margin:2rem 0 1rem}",
  "h2{font-size:1.15rem;margin:2.25rem 0 .75rem;padding-bottom:.35rem;border-bottom:1px solid var(--line)}",
  "h3{font-size:1rem;margin:0 0 .5rem}",
  "h4{font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:1.1rem 0 .4rem}",
  "a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}",
  "p{margin:.35rem 0}ul{margin:.3rem 0;padding-left:1.2rem}li{margin:.25rem 0}",
  "table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}",
  "th,td{border-bottom:1px solid var(--line);padding:.55rem .75rem;text-align:left}tr:last-child td{border-bottom:0}",
  "th{font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600}",
  "dl{display:grid;grid-template-columns:max-content auto;gap:.2rem 1.5rem;margin:0}dt{color:var(--muted)}dd{margin:0;font-variant-numeric:tabular-nums}",
  "section.subtask{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:1rem 1.25rem;margin:1rem 0}",
  "li.attempt{background:var(--muted-bg);border-radius:6px;list-style:none;margin:.5rem 0 .5rem -1.2rem;padding:.5rem .75rem}",
  ".badge{display:inline-block;padding:0 .55rem;border-radius:999px;font-size:.8rem;font-weight:600;background:var(--muted-bg);color:var(--muted)}",
  ".badge.ok{background:var(--ok-bg);color:var(--ok)}.badge.warn{background:var(--warn-bg);color:var(--warn)}",
  ".badge.bad{background:var(--bad-bg);color:var(--bad)}.badge.info{background:var(--info-bg);color:var(--info)}",
].join("");

export interface PageOptions {
  reload?: boolean;
}

export function page(title: string, body: string, { reload = false }: PageOptions = {}): string {
  return [
    "<!doctype html>",
    '<html lang="es">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    ...(reload ? [`<meta http-equiv="refresh" content="${RELOAD_SECONDS}">`] : []),
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
