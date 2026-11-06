export function safeLink(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}
