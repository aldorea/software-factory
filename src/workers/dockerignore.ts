export interface DockerignoreProblem {
  problem: string;
  fix: string;
}

const SECRET_FILE = ".env";

function patternRegExp(pattern: string): RegExp {
  const body = pattern
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .split("**/")
    .map((part) =>
      part
        .split("**")
        .map((piece) =>
          piece
            .split("*")
            .map((fragment) => fragment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\?/g, "[^/]"))
            .join("[^/]*"),
        )
        .join(".*"),
    )
    .join("(?:.*/)?");
  return new RegExp(`^${body}$`);
}

function excludesSecretFile(content: string): boolean {
  let excluded = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const pattern = negated ? line.slice(1).trim() : line;
    if (patternRegExp(pattern).test(SECRET_FILE)) excluded = !negated;
  }
  return excluded;
}

export function dockerignoreProblem(content: string | null): DockerignoreProblem | null {
  if (content === null) {
    return {
      problem: ".factory/.dockerignore does not exist, so the build context would hold .factory/.env",
      fix: "factory init",
    };
  }
  if (excludesSecretFile(content)) return null;
  return {
    problem: ".factory/.dockerignore does not exclude .env, so the build context would hold .factory/.env",
    fix: "add .env to .factory/.dockerignore",
  };
}
