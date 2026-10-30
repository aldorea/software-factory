import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeSessionProblem } from "../../src/workers/claude-session.ts";
import { tempDirs } from "../temp-dirs.ts";

const temp = tempDirs();
afterEach(() => temp.removeAll());

async function fakeClaude(script: string): Promise<string> {
  const dir = await temp.make("claude-session-");
  const command = join(dir, "claude");
  await writeFile(command, `#!/bin/sh\n${script}\n`);
  await chmod(command, 0o755);
  return command;
}

describe("claudeSessionProblem", () => {
  it("should say that Claude Code is not available when its command is missing", async () => {
    expect(await claudeSessionProblem("factory-test-no-such-claude")).toContain("Claude Code is not available");
  });

  it("should find no problem when claude auth status reports a signed-in session", async () => {
    const command = await fakeClaude(`echo '{"loggedIn": true, "authMethod": "claude.ai"}'`);

    expect(await claudeSessionProblem(command)).toBeNull();
  });

  it("should say the session is not signed in when claude auth status reports loggedIn false", async () => {
    const command = await fakeClaude(`echo '{"loggedIn": false}'`);

    expect(await claudeSessionProblem(command)).toBe("the Claude Code session of this host is not signed in");
  });

  it("should say the session is not signed in when claude auth status fails", async () => {
    const command = await fakeClaude("exit 1");

    expect(await claudeSessionProblem(command)).toBe("the Claude Code session of this host is not signed in");
  });

  it("should fail closed when claude auth status succeeds with an output it does not understand", async () => {
    const command = await fakeClaude("echo signed in");

    expect(await claudeSessionProblem(command)).toBe("the Claude Code session of this host is not signed in");
  });
});
