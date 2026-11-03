# Software factory

A personal factory that takes a GitHub issue of a TypeScript repo and returns a verified pull request for human review. No automatic merge and no deploy: the developer reviews and merges every pull request.

This repo holds the coordinator, the worker layer and the `factory` CLI. The target repos live elsewhere; each one keeps its own configuration in `.factory/`.

## How it works

1. **Refinement.** An agent reads the issue and the code of the target repo, asks the developer only the open decisions, and writes the spec: the criteria `A1`, `A2`… in the issue and the technical part in `specs/<n>.md`.
2. **Approval.** The developer approves the spec, which freezes it with a hash of each of its two parts.
3. **Run.** The deterministic coordinator splits the spec into subtasks. Workers implement them in parallel, each in its own container and on its own branch, and each subtask passes a gate before it merges into the integration branch.
4. **Integrated verification.** The checks of the target repo and every criterion run on the integration branch. The independent verifier judges whether each test proves its criterion, and the acceptance tester uses the running app as a user would.
5. **Publication.** The coordinator pushes the branches and opens the pull request, with the evidence of each criterion.

The whole flow, its stop rules and its architecture are in [`docs/design.md`](docs/design.md). The terms used here are defined in [`GLOSSARY.md`](GLOSSARY.md).

### Principles

- Agents run only on subscriptions: the Claude Code CLI and the OpenCode CLI with OpenCode Go ([ADR 0001](docs/adr/0001-subscriptions-only.md)).
- Agents are interchangeable: the developer chooses the agent and the model of each role before each command ([ADR 0003](docs/adr/0003-interchangeable-agents.md)).
- The coordinator is deterministic: every LLM call happens in a worker, in the independent verifier or in the acceptance tester.
- Host secrets stay on the host, and only the coordinator pushes and opens pull requests ([ADR 0005](docs/adr/0005-publish-through-gh-over-https.md)).

## How to use it

You need Node 24, pnpm, Docker, the GitHub CLI `gh` and the Claude Code CLI `claude`, both signed in. The [onboarding guide](docs/onboarding.md) has the exact requirements, the reasons behind each step and the edge cases.

Install the CLI once, from this clone:

```sh
pnpm link --global
```

Prepare each target repo once, from its root:

```sh
factory init      # writes .factory/ and lists the steps left
                  # fill .factory/.env from .factory/.env.example
factory auth      # saves the credential of each agent, once for every repo
factory image     # builds the base image, then the worker image of this repo
factory doctor    # lists every problem left, each with the command that fixes it
```

`factory auth` asks for `CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token`, and for `OPENCODE_API_KEY` if a role uses OpenCode Go. See [Agents and authentication](docs/design.md#agents-and-authentication).

Then, for each issue `<n>`, from the root of the target repo:

```sh
factory refine <n>    # interactive refinement: writes the spec
factory approve <n>   # validates the spec and freezes it
factory run <n>       # implements, verifies and opens the pull request
```

Before `factory refine` and `factory run`, pull the default branch: the factory never fetches. `factory web` shows the run logs in the browser and can start the same commands. The full list of commands is in [`docs/design.md`](docs/design.md#commands).

## Develop the factory

Read [`AGENTS.md`](AGENTS.md) before you change anything: it has the hard rules and the conventions for code and tests.

```sh
pnpm install
pnpm typecheck     # TypeScript, with no emit
pnpm test          # unit and integration tests, with no Docker and no subscription
pnpm image:build   # builds the image of the factory's own Docker tests
pnpm test:docker   # tests that need Docker
```

Run `pnpm typecheck` and `pnpm test` for every change. For a change that touches Docker, also run `pnpm image:build` and `pnpm test:docker`. The Docker tests that reach a real agent run only when `CLAUDE_CODE_OAUTH_TOKEN` or `OPENCODE_API_KEY` is set; the others are skipped.

## Documents

- [`docs/design.md`](docs/design.md): the agreed design.
- [`docs/onboarding.md`](docs/onboarding.md): how to install the CLI and prepare a target repo.
- [`GLOSSARY.md`](GLOSSARY.md): the vocabulary of the project.
- [`docs/adr/`](docs/adr/): why the obvious alternatives were rejected.
- [`AGENTS.md`](AGENTS.md): rules for anyone, human or agent, who changes this repo.
