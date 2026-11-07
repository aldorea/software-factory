#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

wanted="v$(cat .nvmrc)"
if [ "$(node -v 2>/dev/null)" != "$wanted" ] && [ -x /opt/node24/bin/node ] && [ "$(/opt/node24/bin/node -v)" = "$wanted" ]; then
  export PATH="/opt/node24/bin:$PATH"
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo 'export PATH="/opt/node24/bin:$PATH"' >> "$CLAUDE_ENV_FILE"
  fi
fi

if ! command -v pnpm >/dev/null; then
  corepack enable
fi

hashes=node_modules/.session-start.sha256
if ! sha256sum --check --status "$hashes" 2>/dev/null; then
  rm -f "$hashes"
  pnpm install --frozen-lockfile
  sha256sum .claude/hooks/session-start.sh .nvmrc package.json pnpm-lock.yaml > "$hashes" || rm -f "$hashes"
fi
