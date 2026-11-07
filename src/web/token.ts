import { randomBytes, timingSafeEqual } from "node:crypto";

export const TOKEN_COOKIE = "factory-token";

export function newToken(): string {
  return randomBytes(32).toString("hex");
}

export function sameToken(candidate: string | null | undefined, token: string): boolean {
  if (candidate === null || candidate === undefined || token === "") return false;
  const given = Buffer.from(candidate);
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function cookieToken(cookie: string | undefined): string | null {
  for (const part of (cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === TOKEN_COOKIE) return value.join("=");
  }
  return null;
}

export function tokenCookie(token: string): string {
  return `${TOKEN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

export function originAllowed(origin: string | undefined, port: number): boolean {
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export function postAllowed(request: { origin: string | undefined; cookie: string | undefined; token: string; port: number }): boolean {
  return originAllowed(request.origin, request.port) && sameToken(cookieToken(request.cookie), request.token);
}
