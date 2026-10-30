import { DEFAULT_LIMITS, type Check, type Role, type RoleChoice } from "../config/config.ts";
import { BASE_IMAGE_TAG } from "../workers/images.ts";

export type PackageManager = "pnpm" | "npm";

export interface FactoryTemplateInput {
  image: string;
  checks: Check[];
  packageManager: PackageManager;
}

export interface FactoryFile {
  path: string;
  content: string;
}

export const DEFAULT_ROLES: Record<Role, RoleChoice> = {
  workers: { agent: "claude-code", model: "sonnet" },
  verifier: { agent: "claude-code", model: "opus" },
  tester: { agent: "claude-code", model: "sonnet" },
  refinement: { agent: "claude-code", model: "opus" },
};

const BASE_IMAGE = BASE_IMAGE_TAG;
const PNPM_VERSION = "10.19.0";
const BASE_PORT = 3100;
const SLOT_COUNT = Math.max(...Object.values(DEFAULT_LIMITS.agents).map((limits) => limits.maxParallelCeiling));
const SLOT_VARIABLES: Readonly<Record<string, string>> = {
  E2E_DATABASE_URL: "FACTORY_E2E_DATABASE_URL",
};

const CONFIG_HEAD = `import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const BASE_PORT = ${BASE_PORT};
const SLOT_VARIABLES: Record<string, string> = ${JSON.stringify(SLOT_VARIABLES)};

function readEnvFile(): Record<string, string | undefined> {
  const file = new URL("./.env", import.meta.url);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error("Missing .factory/.env: copy .factory/.env.example to .factory/.env and fill in its values.");
  }
  return parseEnv(text);
}

function slotValues(slot: number): Record<string, string> {
  const env = readEnvFile();
  const values: Record<string, string> = {};
  for (const [name, prefix] of Object.entries(SLOT_VARIABLES)) {
    const variable = \`\${prefix}_\${slot}\`;
    const value = env[variable];
    if (!value) throw new Error(\`Missing \${variable} in .factory/.env: each worker slot needs its own value.\`);
    values[name] = value;
  }
  return values;
}
`;

const CONFIG_TAIL = `  roles: ${JSON.stringify(DEFAULT_ROLES, null, 2).replace(/\n/g, "\n  ")},
  environment: ({ slot }: { slot: number }) => ({
    E2E_PORT: String(BASE_PORT + slot),
    ...slotValues(slot),
  }),
  protectedPaths: [".github"],
};

export default config;
`;

function checkLine(check: Check): string {
  return `    { name: ${JSON.stringify(check.name)}, command: ${JSON.stringify(check.command)} },`;
}

export function renderConfig(input: Pick<FactoryTemplateInput, "image" | "checks">): string {
  const checks = input.checks.length === 0 ? "  checks: [],\n" : `  checks: [\n${input.checks.map(checkLine).join("\n")}\n  ],\n`;
  return `${CONFIG_HEAD}
const config = {
  image: ${JSON.stringify(input.image)},
${checks}${CONFIG_TAIL}`;
}

export function renderDockerfile(packageManager: PackageManager): string {
  if (packageManager === "pnpm") {
    return `ARG BASE_IMAGE=${BASE_IMAGE}
FROM \${BASE_IMAGE}

ARG PNPM_VERSION=${PNPM_VERSION}

USER root
RUN npm install -g pnpm@\${PNPM_VERSION} \\
  && rm -rf /root/.npm

ENV npm_config_store_dir=/home/agent/.pnpm-store

USER agent
RUN pnpm --version
`;
  }
  return `ARG BASE_IMAGE=${BASE_IMAGE}
FROM \${BASE_IMAGE}

USER agent
RUN npm --version
`;
}

export function renderDockerignore(): string {
  return ".env\n";
}

export function renderEnvExample(): string {
  const names = Object.values(SLOT_VARIABLES).flatMap((prefix) =>
    Array.from({ length: SLOT_COUNT }, (_, slot) => `${prefix}_${slot}=`),
  );
  return `# Read by .factory/config.ts on the host; never mounted into a container.
# Slot n gets each variable ending in _n, and E2E_PORT ${BASE_PORT} + n.
${names.join("\n")}
`;
}

export function renderPackageJson(): string {
  return `${JSON.stringify({ type: "module" }, null, 2)}\n`;
}

export function factoryFiles(input: FactoryTemplateInput): FactoryFile[] {
  return [
    { path: ".factory/config.ts", content: renderConfig(input) },
    { path: ".factory/Dockerfile", content: renderDockerfile(input.packageManager) },
    { path: ".factory/.dockerignore", content: renderDockerignore() },
    { path: ".factory/.env.example", content: renderEnvExample() },
    { path: ".factory/package.json", content: renderPackageJson() },
  ];
}
