# Software factory

A personal factory that takes a GitHub issue of a TypeScript repo and returns a verified pull request for human review. This repo holds the coordinator, the worker layer and the `factory` CLI; the target repos live elsewhere.

## Before you change anything

- **Design**: read the section of [`docs/design.md`](docs/design.md) that your change touches. It is the agreed design: a change that departs from it is a design question to raise with the developer before you write code.
- **Vocabulary**: name concepts in code, tests, commits and issues with the terms of [`GLOSSARY.md`](GLOSSARY.md).
- **Decisions**: [`docs/adr/`](docs/adr/) records why the obvious alternatives were rejected. Surface any conflict with an ADR explicitly.

## Hard rules

- Agents run only on subscriptions: today the Claude Code CLI with a `setup-token` token, and the OpenCode CLI with an OpenCode Go key and `opencode-go/` models ([ADR 0001](docs/adr/0001-subscriptions-only.md)). They are interchangeable: the developer chooses the agent and model of each role before a run ([ADR 0003](docs/adr/0003-interchangeable-agents.md)). Do not remove or degrade the support of an agent.
- The worker layer is our own code; Sandcastle is read for reference only ([ADR 0002](docs/adr/0002-own-worker-layer.md)).
- The coordinator stays deterministic: every LLM call happens in a worker, in the independent verifier or in the acceptance tester.
- A container receives only what the design lists for it. Host secrets (`.env`, `~/.ssh`, the `gh` session) stay on the host, and only the coordinator pushes and opens pull requests.

## Code, comments and tests

### Code

- Keep decisions in pure functions that take the time (`now`) as a parameter, and keep I/O (processes, Docker, git, files) in separate modules.
- Return what can happen to an agent as data, in a discriminated union such as `AttemptOutcome`. Throw only for broken preconditions and failures of the environment. Swallow errors only on cleanup paths.
- Start processes with `execFile` or `spawn` and an array of arguments; never interpolate a value into a shell string. Secrets travel only in an env file with mode `0600`, removed in a `finally`.
- Do not relax the options of `tsconfig.json`, and do not add a runtime dependency without a reason the developer accepts.
- When code can check a hard rule, it checks it and fails closed, as `openCodeArgs` refuses a model outside `opencode-go/`.
- In code, `run` names only the glossary's Run. A process or a Docker command is not a run.

### Comments

- No comments in the code. The reason for a behaviour that is not obvious goes in the name of a test that pins it.

### Tests

- Every decision that fails closed has a test that runs with no Docker and no subscription.
- No mocks of processes, git or the file system: use real processes and temporary repos. The only test double is the fake `WorkerRunner` of the design.
- The stream lines of an agent in a test come from a real log. When the version of a CLI changes in `docker/Dockerfile`, capture them again.
- Name tests in should notation, `it("should …")`, stating the behaviour and, when it is not obvious, why.
- Do not weaken or delete an existing test to make a change pass without saying so in the commit.
- A test removes what it creates: temporary directories, worktrees and containers.

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
