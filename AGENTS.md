# Software factory

A personal factory that takes a GitHub issue of a TypeScript repo and returns a verified pull request for human review. This repo holds the coordinator, the worker layer and the `factory` CLI; the target repos live elsewhere.

## Before you change anything

- **Design**: read the section of [`docs/design.md`](docs/design.md) that your change touches. It is the agreed design: a change that departs from it is a design question to raise with the developer before you write code.
- **Vocabulary**: name concepts in code, tests, commits and issues with the terms of [`GLOSSARY.md`](GLOSSARY.md).
- **Decisions**: [`docs/adr/`](docs/adr/) records why the obvious alternatives were rejected. Surface any conflict with an ADR explicitly.

## Hard rules

- Agents run only on subscriptions: the Claude Code CLI with a `setup-token` token, and the OpenCode CLI with an OpenCode Go key and `opencode-go/` models ([ADR 0001](docs/adr/0001-subscriptions-only.md)).
- The worker layer is our own code; Sandcastle is read for reference only ([ADR 0002](docs/adr/0002-own-worker-layer.md)).
- The coordinator stays deterministic: every LLM call happens in a worker or in the independent verifier.
- A container receives only what the design lists for it. Host secrets (`.env`, `~/.ssh`, the `gh` session) stay on the host, and only the coordinator pushes and opens pull requests.

## Verify a change

- `pnpm typecheck` and `pnpm test` for every change.
- For changes that touch Docker, build the image with `pnpm image:build` and run `pnpm test:docker`. The tests that reach a real agent run only when `CLAUDE_CODE_OAUTH_TOKEN` or `OPENCODE_API_KEY` is set; a skipped test is not a passing one, so say which ones ran.

## Agent skills

### Issue tracker

GitHub Issues of `aldorea/software-factory`, through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default roles, with their default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
