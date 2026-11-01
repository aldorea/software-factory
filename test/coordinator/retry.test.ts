import { describe, expect, it } from "vitest";
import { classifyFailure, retryDelayMs, withRetries, type Attempt } from "../../src/coordinator/retry.ts";

describe("classifyFailure", () => {
  const network = [
    "ssh: connect to host github.com port 22: Operation timed out",
    "ssh: connect to host github.com port 22: Connection refused",
    "ssh: Could not resolve hostname github.com: nodename nor servname provided, or not known",
    "kex_exchange_identification: read: Connection reset by peer",
    "kex_exchange_identification: Connection closed by remote host",
    "fatal: unable to access 'https://github.com/aldorea/repo.git/': Could not resolve host: github.com",
    "fatal: unable to access 'https://github.com/aldorea/repo.git/': Failed to connect to github.com port 443 after 75003 ms: Couldn't connect to server",
    "fatal: unable to access 'https://github.com/aldorea/repo.git/': Connection timed out after 30001 milliseconds",
    "fatal: unable to access 'https://github.com/aldorea/repo.git/': Operation timed out after 300001 milliseconds with 0 bytes received",
    "fatal: unable to access 'https://github.com/aldorea/repo.git/': Recv failure: Connection reset by peer",
    "fatal: unable to access 'https://github.com/aldorea/repo.git/': OpenSSL SSL_read: Connection reset by peer, errno 54",
    "fatal: unable to access 'http://127.0.0.1:1/aldorea/repo.git/': Failed to connect to 127.0.0.1 port 1 after 0 ms: Couldn't connect to server",
    "error: RPC failed; curl 56 Recv failure: Connection reset by peer\nfatal: the remote end hung up unexpectedly",
    "error: RPC failed; curl 18 transfer closed with outstanding read data remaining\nsend-pack: unexpected disconnect while reading sideband packet\nfatal: the remote end hung up unexpectedly",
    "fatal: unable to access 'https://github.com/aldorea/repo.git/': OpenSSL SSL_write: Broken pipe, errno 32",
    "gh pr create failed (1): error connecting to api.github.com",
    'gh api failed (1): Get "https://api.github.com/repos/aldorea/repo/pulls": dial tcp: lookup api.github.com: no such host',
    'gh api failed (1): Post "https://api.github.com/repos/aldorea/repo/pulls": dial tcp 140.82.121.5:443: i/o timeout',
  ];

  it.each(network)("should classify %j as a network failure", (stderr) => {
    expect(classifyFailure(stderr, stderr.startsWith("ssh") || stderr.startsWith("kex") ? 255 : 128)).toBe("network");
  });

  const other = [
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/aldorea/repo.git/'",
    "remote: Permission to aldorea/repo.git denied to someone.\nfatal: unable to access 'https://github.com/aldorea/repo.git/': The requested URL returned error: 403",
    "To https://github.com/aldorea/repo.git\n ! [remote rejected] factory/42 -> factory/42 (refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)",
    "To https://github.com/aldorea/repo.git\n ! [rejected]        factory/42 -> factory/42 (non-fast-forward)",
    "fatal: unable to access 'https://github.com/aldorea/missing.git/': The requested URL returned error: 404",
    "gh pr create failed (1): GraphQL: Validation Failed (createPullRequest)",
    "error: RPC failed; HTTP 400 curl 22 The requested URL returned error: 400\nfatal: the remote end hung up unexpectedly",
    "error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502\nfatal: the remote end hung up unexpectedly",
    "error: RPC failed; HTTP 400 curl 22 The requested URL returned error: 400\nsend-pack: unexpected disconnect while reading sideband packet\nfatal: the remote end hung up unexpectedly",
    "fatal: the remote end hung up unexpectedly",
    "",
  ];

  it.each(other)("should classify %j as another failure", (stderr) => {
    expect(classifyFailure(stderr, 128)).toBe("other");
  });
});

describe("retryDelayMs", () => {
  it("should wait 5, 15 and 45 seconds after the first, second and third failure of a network failure, and then give up", () => {
    expect([1, 2, 3, 4, 5].map((failures) => retryDelayMs(failures, "network"))).toEqual([5_000, 15_000, 45_000, null, null]);
  });

  it("should not wait for a failure that is not a network failure, because retrying cannot fix a missing permission", () => {
    expect([1, 2, 3].map((failures) => retryDelayMs(failures, "other"))).toEqual([null, null, null]);
  });
});

describe("withRetries", () => {
  function scripted(results: Attempt<string>[]): { attempt: () => Promise<Attempt<string>>; calls: () => number } {
    let calls = 0;
    return {
      attempt: async () => results[Math.min(calls++, results.length - 1)]!,
      calls: () => calls,
    };
  }

  const timedOut: Attempt<string> = { ok: false, message: "ssh: connect to host github.com port 22: Operation timed out", failure: "network" };
  const denied: Attempt<string> = { ok: false, message: "permission denied", failure: "other" };

  it("should return the value of the first attempt without waiting", async () => {
    const waits: number[] = [];
    const { attempt, calls } = scripted([{ ok: true, value: "pushed" }]);

    const outcome = await withRetries(attempt, { sleep: async (ms) => void waits.push(ms), onRetry: () => {} });

    expect(outcome).toEqual({ ok: true, value: "pushed" });
    expect(calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  it("should retry a network failure after 5 and 15 seconds and return the value of the third attempt", async () => {
    const waits: number[] = [];
    const { attempt, calls } = scripted([timedOut, timedOut, { ok: true, value: "pushed" }]);

    const outcome = await withRetries(attempt, { sleep: async (ms) => void waits.push(ms), onRetry: () => {} });

    expect(outcome).toEqual({ ok: true, value: "pushed" });
    expect(calls()).toBe(3);
    expect(waits).toEqual([5_000, 15_000]);
  });

  it("should give up after the third retry and return the last failure", async () => {
    const waits: number[] = [];
    const { attempt, calls } = scripted([timedOut]);

    const outcome = await withRetries(attempt, { sleep: async (ms) => void waits.push(ms), onRetry: () => {} });

    expect(outcome).toEqual(timedOut);
    expect(calls()).toBe(4);
    expect(waits).toEqual([5_000, 15_000, 45_000]);
  });

  it("should not retry a failure that is not a network failure", async () => {
    const waits: number[] = [];
    const { attempt, calls } = scripted([denied]);

    const outcome = await withRetries(attempt, { sleep: async (ms) => void waits.push(ms), onRetry: () => {} });

    expect(outcome).toEqual(denied);
    expect(calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  it("should tell each retry with its number, its wait and the message that caused it, before it waits", async () => {
    const events: string[] = [];
    const { attempt } = scripted([timedOut, timedOut, { ok: true, value: "pushed" }]);

    await withRetries(attempt, {
      sleep: async (ms) => void events.push(`sleep ${ms}`),
      onRetry: (retry) => events.push(`retry ${retry.retry} of ${retry.retries} in ${retry.waitMs}: ${retry.message}`),
    });

    expect(events).toEqual([
      `retry 1 of 3 in 5000: ${timedOut.message}`,
      "sleep 5000",
      `retry 2 of 3 in 15000: ${timedOut.message}`,
      "sleep 15000",
    ]);
  });
});
