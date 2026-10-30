import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AuthInput } from "../../src/cli/auth.ts";
import { main, type CliEnv } from "../../src/cli/main.ts";
import { reduceSecret, type SecretState } from "../../src/cli/secret-input.ts";
import { FakeClock } from "../fakes/clock.ts";
import { FakeGitHub } from "../fakes/github.ts";
import { FakeNotifier } from "../fakes/notifier.ts";
import { FakeVerifier } from "../fakes/verifier.ts";
import { FakeWorkerRunner } from "../fakes/worker-runner.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

interface Session {
  terminal?: boolean;
  secret?: string | null;
  confirms?: boolean;
  environment?: Record<string, string>;
}

async function session(options: Session = {}) {
  const credentialsPath = join(await temp.make("auth-"), "software-factory", "credentials");
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const auth: AuthInput = {
    credentialsPath,
    environment: options.environment ?? {},
    terminal: options.terminal ?? false,
    readSecret: async (prompt) => {
      asked.push(prompt);
      return options.secret === undefined ? null : options.secret;
    },
    confirm: async (question) => {
      asked.push(question);
      return options.confirms ?? false;
    },
  };
  const env: CliEnv = {
    cwd: "/nowhere",
    factoryRoot: "/factory",
    clock: new FakeClock("2026-10-24T08:00:00.000Z"),
    github: () => new FakeGitHub([]),
    runner: () => new FakeWorkerRunner(),
    verifier: () => new FakeVerifier(),
    notifier: new FakeNotifier(),
    credentials: {},
    docker: async () => null,
    gh: async () => null,
    launch: async () => 0,
    signal: new AbortController().signal,
    auth,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };
  return { env, out, err, asked, credentialsPath };
}

describe("factory auth", () => {
  it("should save the credential read from stdin with no terminal, in a folder 0700 and a file 0600, and explain nothing before it", async () => {
    const { env, out, err, asked, credentialsPath } = await session({ secret: "sk-ant-oat01-abc" });

    expect(await main(["auth", "claude-code"], env)).toBe(0);

    expect(await readFile(credentialsPath, "utf8")).toBe("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc\n");
    expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(credentialsPath))).mode & 0o777).toBe(0o700);
    expect(asked).toEqual([""]);
    expect(out).toEqual([expect.stringContaining("saved CLAUDE_CODE_OAUTH_TOKEN")]);
    expect(err).toEqual([]);
  });

  it("should explain the credential before it asks in a terminal: what it is, the roles, how to get it, where it is saved and that the environment wins", async () => {
    const { env, out, asked, credentialsPath } = await session({ terminal: true, secret: "sk-ant-oat01-abc" });

    expect(await main(["auth", "claude-code"], env)).toBe(0);

    const text = out.join("\n");
    expect(text).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(text).toContain("workers, verifier, tester");
    expect(text).toContain("claude setup-token");
    expect(text).toContain("Max plan");
    expect(text).toContain(credentialsPath);
    expect(text).toContain("every target repo");
    expect(text).toContain("wins over the saved one");
    expect(asked).toEqual(["Paste the credential (it is not shown): "]);
  });

  it("should name the OpenCode Go key with Extra Usage off for opencode", async () => {
    const { env, out } = await session({ terminal: true, secret: "key-1" });

    expect(await main(["auth", "opencode"], env)).toBe(0);

    expect(out.join("\n")).toContain("OpenCode Go key, with Extra Usage turned off");
  });

  it("should warn that the environment variable wins when it is set while it saves", async () => {
    const { env, out } = await session({ secret: "key-1", environment: { OPENCODE_API_KEY: "other" } });

    expect(await main(["auth", "opencode"], env)).toBe(0);

    expect(out.join("\n")).toContain("OPENCODE_API_KEY is set in the environment and wins over the saved one");
  });

  it.each([
    ["an empty value", ""],
    ["a value with a space", "ab cd"],
    ["a value with a line break", "ab\ncd"],
  ])("should save nothing and fail on %s", async (_name, secret) => {
    const { env, err, credentialsPath } = await session({ secret });

    expect(await main(["auth", "opencode"], env)).toBe(1);

    expect(err.join("\n")).toContain("factory:");
    await expect(stat(credentialsPath)).rejects.toThrow();
  });

  it("should save a Claude Code token with an unexpected prefix only after the developer confirms", async () => {
    const confirmed = await session({ terminal: true, secret: "abc", confirms: true });
    expect(await main(["auth", "claude-code"], confirmed.env)).toBe(0);
    expect(await readFile(confirmed.credentialsPath, "utf8")).toBe("CLAUDE_CODE_OAUTH_TOKEN=abc\n");
    expect(confirmed.out.join("\n")).toContain("sk-ant-oat");

    const declined = await session({ terminal: true, secret: "abc", confirms: false });
    expect(await main(["auth", "claude-code"], declined.env)).toBe(1);
    await expect(stat(declined.credentialsPath)).rejects.toThrow();
  });

  it("should not save a token with an unexpected prefix when there is no terminal to confirm", async () => {
    const { env, err, credentialsPath } = await session({ secret: "abc" });

    expect(await main(["auth", "claude-code"], env)).toBe(1);

    expect(err.join("\n")).toContain("nobody to confirm");
    await expect(stat(credentialsPath)).rejects.toThrow();
  });

  it("should fail with the list of agents on an unknown agent", async () => {
    const { env, err } = await session({ secret: "x" });

    expect(await main(["auth", "gemini"], env)).toBe(1);

    expect(err.join("\n")).toContain("gemini is not an agent: use one of claude-code, opencode");
  });

  it("should stop with the chmod fix when the saved file can be read by others, and not change it", async () => {
    const { env, err, credentialsPath } = await session({ secret: "key-1" });
    await mkdir(dirname(credentialsPath), { recursive: true, mode: 0o700 });
    await writeFile(credentialsPath, "OPENCODE_API_KEY=old\n");
    await chmod(credentialsPath, 0o644);

    expect(await main(["auth", "opencode"], env)).toBe(1);

    expect(err.join("\n")).toContain(`chmod 600 ${credentialsPath}`);
    expect(await readFile(credentialsPath, "utf8")).toBe("OPENCODE_API_KEY=old\n");
  });

  it("should print the help with one line for each agent on --help and with no agent, and exit 0", async () => {
    for (const args of [["auth", "--help"], ["auth"]]) {
      const { env, out } = await session();
      expect(await main(args, env)).toBe(0);
      expect(out.join("\n")).toContain("usage: factory auth <agent>");
      expect(out.filter((line) => line.includes("CLAUDE_CODE_OAUTH_TOKEN"))).toHaveLength(1);
      expect(out.filter((line) => line.includes("OPENCODE_API_KEY"))).toHaveLength(1);
    }
  });

  it("should list factory auth in the usage of the CLI", async () => {
    const { env, err } = await session();

    expect(await main([], env)).toBe(2);

    expect(err.join("\n")).toContain("factory auth <agent>");
  });
});

describe("reduceSecret", () => {
  const open: SecretState = { value: "", outcome: "open" };

  it("should collect typed characters, drop the last one on backspace and finish on Enter", () => {
    let state = open;
    for (const key of [{ char: "a" }, { char: "b" }, { char: "c" }, "backspace", "enter"] as const) {
      state = reduceSecret(state, key);
    }
    expect(state).toEqual({ value: "ab", outcome: "done" });
  });

  it("should cancel on Esc and on Ctrl-C", () => {
    expect(reduceSecret(open, "escape").outcome).toBe("cancelled");
    expect(reduceSecret(open, "ctrl-c").outcome).toBe("cancelled");
  });

  it("should ignore the arrows and a key pressed after it finished", () => {
    expect(reduceSecret(open, "up")).toEqual(open);
    const done = reduceSecret({ value: "a", outcome: "open" }, "enter");
    expect(reduceSecret(done, { char: "z" })).toEqual(done);
  });
});
