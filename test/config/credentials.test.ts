import { describe, expect, it } from "vitest";
import {
  checkCredentialInput,
  credentialHint,
  credentialRoles,
  credentialSource,
  credentialsFilePath,
  parseCredentialsFile,
  credentialOrigin,
  maskCredential,
  removeCredentialLine,
  replaceCredentialLine,
  resolveCredentials,
} from "../../src/config/credentials.ts";
import { ROLES } from "../../src/config/roles.ts";

describe("credentialsFilePath", () => {
  it("should use XDG_CONFIG_HOME when it is set and ~/.config when it is not or is empty", () => {
    expect(credentialsFilePath({ XDG_CONFIG_HOME: "/xdg" }, "/home/d")).toBe("/xdg/software-factory/credentials");
    expect(credentialsFilePath({}, "/home/d")).toBe("/home/d/.config/software-factory/credentials");
    expect(credentialsFilePath({ XDG_CONFIG_HOME: "" }, "/home/d")).toBe("/home/d/.config/software-factory/credentials");
  });
});

describe("parseCredentialsFile", () => {
  it("should read one VARIABLE=value line for each saved agent", () => {
    expect(parseCredentialsFile("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-a\nOPENCODE_API_KEY=key\n", "/f")).toEqual({
      ok: true,
      values: { "claude-code": "sk-ant-oat-a", opencode: "key" },
    });
  });

  it("should accept an empty file and blank lines", () => {
    expect(parseCredentialsFile("", "/f")).toEqual({ ok: true, values: {} });
    expect(parseCredentialsFile("\nOPENCODE_API_KEY=key\n\n", "/f")).toEqual({ ok: true, values: { opencode: "key" } });
  });

  it.each([
    ["a line with no equals sign", "garbage\n"],
    ["a variable it does not know", "HOME=/x\n"],
    ["a comment, because the file holds nothing else", "# note\nOPENCODE_API_KEY=secret-value\n"],
    ["a variable twice", "OPENCODE_API_KEY=secret-value\nOPENCODE_API_KEY=other\n"],
    ["an empty value", "OPENCODE_API_KEY=\n"],
  ])("should fail closed on %s, without printing any value", (_name, text) => {
    const result = parseCredentialsFile(text, "/f");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toContain("/f");
      expect(result.problem).not.toContain("secret-value");
    }
  });
});

describe("resolveCredentials", () => {
  it("should let a non-empty environment variable win over the saved credential", () => {
    expect(
      resolveCredentials({ OPENCODE_API_KEY: "from-env" }, { opencode: "saved", "claude-code": "saved-claude" }),
    ).toEqual({ opencode: "from-env", "claude-code": "saved-claude" });
  });

  it("should fall back to the saved credential when the environment variable is empty", () => {
    expect(resolveCredentials({ OPENCODE_API_KEY: "" }, { opencode: "saved" })).toEqual({ opencode: "saved" });
  });

  it("should leave an agent out when neither source has its credential", () => {
    expect(resolveCredentials({}, {})).toEqual({});
  });

  it("should say where the credential of an agent comes from", () => {
    expect(credentialSource("opencode", { OPENCODE_API_KEY: "x" }, { opencode: "y" })).toBe("environment");
    expect(credentialSource("opencode", {}, { opencode: "y" })).toBe("saved");
    expect(credentialSource("opencode", {}, {})).toBe("none");
  });
});

describe("checkCredentialInput", () => {
  it("should reject an empty value", () => {
    expect(checkCredentialInput("opencode", "").kind).toBe("rejected");
  });

  it("should reject a space and a line break, which would break the env file of the container", () => {
    expect(checkCredentialInput("opencode", "ab cd").kind).toBe("rejected");
    expect(checkCredentialInput("opencode", "ab\ncd").kind).toBe("rejected");
    expect(checkCredentialInput("opencode", "abcd\r").kind).toBe("rejected");
  });

  it("should reject a character that Node's env parser would read as a quote or a comment", () => {
    for (const value of ['a"b', "a'b", "a#b", "a`b", "a\\b"]) {
      expect(checkCredentialInput("opencode", value).kind).toBe("rejected");
    }
  });

  it("should warn when a Claude Code token does not start with sk-ant-oat", () => {
    expect(checkCredentialInput("claude-code", "abc").kind).toBe("warning");
    expect(checkCredentialInput("claude-code", "sk-ant-oat01-abc").kind).toBe("accepted");
  });

  it("should accept any OpenCode key, because it has no known prefix", () => {
    expect(checkCredentialInput("opencode", "abc").kind).toBe("accepted");
  });
});

describe("replaceCredentialLine", () => {
  it("should append the line of an agent that is not in the file", () => {
    expect(replaceCredentialLine("OPENCODE_API_KEY=a\n", "CLAUDE_CODE_OAUTH_TOKEN", "t")).toBe(
      "OPENCODE_API_KEY=a\nCLAUDE_CODE_OAUTH_TOKEN=t\n",
    );
    expect(replaceCredentialLine("", "OPENCODE_API_KEY", "a")).toBe("OPENCODE_API_KEY=a\n");
  });

  it("should change only the line of that agent and keep the others as they are", () => {
    expect(replaceCredentialLine("OPENCODE_API_KEY=a\n\nCLAUDE_CODE_OAUTH_TOKEN=old\n", "CLAUDE_CODE_OAUTH_TOKEN", "new")).toBe(
      "OPENCODE_API_KEY=a\n\nCLAUDE_CODE_OAUTH_TOKEN=new\n",
    );
  });
});

describe("credential texts", () => {
  it("should list the roles that run in a container with the credential of the agent", () => {
    expect(credentialRoles("claude-code", ROLES)).toEqual(["workers", "verifier", "tester"]);
  });

  it("should give the hint in one line with how to get the credential and the command that saves it", () => {
    const hint = credentialHint("claude-code");
    expect(hint).not.toContain("\n");
    expect(hint).toContain("claude setup-token");
    expect(hint).toContain("factory auth claude-code");
  });
});

describe("removeCredentialLine", () => {
  it("should drop only the line of the variable", () => {
    expect(removeCredentialLine("OPENCODE_API_KEY=a\nCLAUDE_CODE_OAUTH_TOKEN=b\n", "OPENCODE_API_KEY")).toBe(
      "CLAUDE_CODE_OAUTH_TOKEN=b\n",
    );
  });

  it("should return an empty text when no line is left", () => {
    expect(removeCredentialLine("OPENCODE_API_KEY=a\n", "OPENCODE_API_KEY")).toBe("");
  });

  it("should leave a text without the variable as it was", () => {
    expect(removeCredentialLine("OPENCODE_API_KEY=a\n", "CLAUDE_CODE_OAUTH_TOKEN")).toBe("OPENCODE_API_KEY=a\n");
  });
});

describe("maskCredential", () => {
  it("should show only the last 4 characters", () => {
    expect(maskCredential("sk-ant-oat01-abcdef1f3a")).toBe("…1f3a");
  });

  it("should show the last 4 characters of a value of 12 characters", () => {
    expect(maskCredential("abcdefgh1234")).toBe("…1234");
  });

  it.each(["abcd", "abcdefg", "abcdefghijk"])("should show nothing of a value of %s, because 4 characters are too much of a short secret", (value) => {
    expect(maskCredential(value)).toBe("…");
  });
});

describe("credentialOrigin", () => {
  it("should say saved with the last 4 characters when only the file holds it", () => {
    expect(credentialOrigin("claude-code", {}, { "claude-code": "sk-ant-oat01-xxxxa1f3" })).toBe("saved (…a1f3)");
  });

  it("should say the environment wins when it holds it, with or without a saved one", () => {
    expect(credentialOrigin("opencode", { OPENCODE_API_KEY: "e" }, { opencode: "s" })).toBe("from environment (wins over saved)");
    expect(credentialOrigin("opencode", { OPENCODE_API_KEY: "e" }, {})).toBe("from environment (wins over saved)");
  });

  it("should say not set when neither holds it, and treat an empty variable as not set", () => {
    expect(credentialOrigin("opencode", { OPENCODE_API_KEY: "" }, {})).toBe("not set");
  });
});
