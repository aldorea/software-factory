export const WEB_HOST = "127.0.0.1";

export function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `${WEB_HOST}:${port}` || host === `localhost:${port}`;
}
