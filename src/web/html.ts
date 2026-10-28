import { RELOAD_SECONDS } from "./reload.ts";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] as string);
}

export function safeLink(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

export function anchor(url: string, text: string): string {
  const href = safeLink(url);
  return href === null ? escapeHtml(text) : `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
}

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
    "<style>body{font-family:system-ui,sans-serif;margin:2rem auto;max-width:60rem;padding:0 1rem}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #8884;padding:.4rem .6rem;text-align:left}</style>",
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
