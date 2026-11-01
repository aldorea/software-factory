export type FailureKind = "network" | "other";

export type Attempt<T> = { ok: true; value: T } | { ok: false; message: string; failure: FailureKind };

export interface Retry {
  retry: number;
  retries: number;
  waitMs: number;
  message: string;
}

export interface RetryOptions {
  sleep(ms: number): Promise<void>;
  onRetry(retry: Retry): void;
}

const NETWORK_FAILURES = [
  /operation timed out/i,
  /connection timed out/i,
  /connection refused/i,
  /connection reset/i,
  /connection closed by remote host/i,
  /could not resolve host/i,
  /could not resolve hostname/i,
  /couldn't connect to server/i,
  /failed to connect to .+ port \d+/i,
  /remote end hung up unexpectedly/i,
  /unexpected disconnect while reading sideband packet/i,
  /RPC failed; HTTP 50[234]/i,
  /error connecting to /i,
  /no such host/i,
  /i\/o timeout/i,
  /network is unreachable/i,
];

const WAITS_MS = [5_000, 15_000, 45_000];

export const RETRIES = WAITS_MS.length;

export function classifyFailure(stderr: string, exitCode: number): FailureKind {
  if (exitCode === 0) return "other";
  return NETWORK_FAILURES.some((pattern) => pattern.test(stderr)) ? "network" : "other";
}

export function retryDelayMs(failures: number, failure: FailureKind): number | null {
  if (failure !== "network") return null;
  return WAITS_MS[failures - 1] ?? null;
}

export async function withRetries<T>(attempt: () => Promise<Attempt<T>>, options: RetryOptions): Promise<Attempt<T>> {
  for (let failures = 1; ; failures++) {
    const outcome = await attempt();
    if (outcome.ok) return outcome;
    const waitMs = retryDelayMs(failures, outcome.failure);
    if (waitMs === null) return outcome;
    options.onRetry({ retry: failures, retries: RETRIES, waitMs, message: outcome.message });
    await options.sleep(waitMs);
  }
}

export function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
