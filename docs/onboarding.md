# Onboarding: run the factory on a target repo

How to install the `factory` CLI once and prepare any TypeScript repo to use it. For what the factory does and why, see [`design.md`](design.md); for the terms, [`../GLOSSARY.md`](../GLOSSARY.md).

## The short path

From the factory's clone, once:

```sh
pnpm link --global
```

Then, from the root of each target repo:

```sh
factory init      # writes .factory/ and ends with the steps left
                  # fill .factory/.env from .factory/.env.example
factory auth      # once for every repo: the credential of each agent
factory image     # the base image, then the worker image of this repo
factory doctor    # every problem left, each with the command that fixes it
factory refine <n>
```

Each command explains what it needs and how to fix what is missing, so this page is for the reasons and the edge cases.

## What you need on the host

- Node 24 (`engines` in [`package.json`](../package.json) has the exact floor), pnpm, Docker and the GitHub CLI `gh`, signed in (`gh auth login`).
- The Claude Code CLI, `claude`, signed in: the refinement runs it on the host with your session.
- The credential of each agent that a run will use: `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` and, for OpenCode Go, `OPENCODE_API_KEY`. `factory auth` saves them once, outside every repo; an environment variable of the same name wins over the saved one. A run asks only for the credentials of the roles its spec needs: the tester has none to set when every criterion is for a human. `factory auth` refuses a value with a space, a line break, a `#`, a quote, a backtick or a backslash, because Node's env parser would truncate or unquote it. With no terminal, `factory auth claude-code --force` saves a token that does not start with `sk-ant-oat`; in a terminal it asks you to confirm. See [ADR 0001](adr/0001-subscriptions-only.md) and [design.md](design.md#agents-and-authentication).

`factory doctor` checks all of this, and `factory run` and `factory refine` check what they need before they start.

## 1. Install the CLI

The factory is a local clone that you link, not a published package. From the clone, `pnpm link --global` puts `factory` on your PATH, under the Node of your shell. The bin is TypeScript that Node 24 runs as it is, so there is no build step. If `pnpm link --global` complains that there is no global bin directory, run `pnpm setup` and open a new shell.

## 2. Prepare the target repo

From the root of the target repo, `factory init` stops with a message when the folder is not the root of a git repo, or the repo has no `origin` remote. It writes the files of `.factory/` that are missing (including `.factory/.dockerignore`), adds `.factory/logs/`, `.factory/worktrees/` and `.factory/.env` to `.gitignore` when they are not there, and lists each file as written or skipped. It never overwrites a file, so you can run it again on a half-prepared repo, and it never touches the repo's `package.json`. The templates are in [`src/init/templates.ts`](../src/init/templates.ts) and the decisions in [`src/init/plan.ts`](../src/init/plan.ts).

What the generated files assume, and what you may need to change:

- **Checks.** The first check installs the dependencies in a fresh worktree, with the command that the lockfile implies: only `pnpm-lock.yaml` (`pnpm install --frozen-lockfile`) and `package-lock.json` (`npm ci`) are recognised. After it come the `lint`, `typecheck` and `test` scripts of the repo's `package.json` that exist. A config with no checks is rejected when it loads.
- **No recognised lockfile (yarn, or none).** `init` writes no install check, and its Dockerfile is the npm one, with no other package manager added. Add an install check as the first one, and make sure `.factory/Dockerfile` provides the package manager it uses. Without the install check the worktree has no `node_modules` and every later check fails.
- **The config imports nothing from the factory** and reads `.factory/.env` itself, with Node's own parser. It fails with a message naming the file or the variable that is missing. Copy `.factory/.env.example` to `.factory/.env` and fill it in.
- **The database variable.** The generated `environment` gives each worker slot its own `E2E_PORT` and its own `FACTORY_E2E_DATABASE_URL_<slot>` from `.env`. `.env.example` lists one variable for each slot that the default parallelism ceiling can reach (2 today): if you raise `maxParallelCeiling` in the config, add a variable for each new slot. A repo with no database removes that variable from the config and from `.env.example`; otherwise the run fails on the missing value.
- **Roles.** The config sets a default agent and model for each role: Claude Code everywhere, `opus` for the refinement and the independent verifier, `sonnet` for the workers and the acceptance tester. Change them there, or per command with a flag or the menu.
- **The image name** is `<repo folder>-factory-worker:dev`, with the folder name cut to the characters that Docker allows.
- **Evidence and app.** The generated config has no `app` and no `evidence` commands. Add them before a run that has Playwright or request criteria: a criterion whose type has no command stops the run before any worker starts.
- **Anything else the image needs** (Playwright, a browser) goes in `.factory/Dockerfile`.
- **The pnpm store stays outside the worktree.** The worktree is a bind mount, so pnpm would put its store inside it, leave the worktree dirty and keep the subtask branch checked out. The generated pnpm Dockerfile sets `npm_config_store_dir=/home/agent/.pnpm-store`; a Dockerfile written by hand needs the same line.

A mistake in the config is reported field by field when it loads. `factory validate <issue>` loads it too.

## 3. Build the images

Each worker runs in a container of the worker image of its repo, built `FROM` the base image, which holds the agents. From the root of the target repo, `factory image` builds both, in that order: the base image from the factory's clone with your user and group ids, so that bind-mounted worktrees stay yours, then the worker image with the `image` name of the config, from `.factory/Dockerfile` and with `.factory/` as the build context. `.factory/.dockerignore` keeps `.factory/.env` out of that context: `factory init` writes it with a `.env` line and never overwrites it, and `factory image` and `factory doctor` fail when it is missing or does not exclude `.env`. If you wrote your own, add the line `.env`. The worker image records which base image it was built from, and `factory run` refuses a worker image built by hand or from an older base image. Run `factory image` again after you pull the factory or change `.factory/Dockerfile`.

## 4. Where and how to run the commands

- **Run every command from the root of the target repo.** The target repo is the current directory, or the last argument. The run logs go to `.factory/logs/` of that directory, and `factory stats` reads them there. Every command refuses to work on a folder inside `.factory/worktrees/`, where the logs would land in the worktree.
- **Update the default branch before `factory refine`.** The integration branch starts from your local copy of the default branch (the branch that `origin/HEAD` points to), and the factory never fetches. Check it out and pull it first, or the spec starts from old code, and local commits on it are included. The command stops with the fix when it cannot resolve the branch: `git remote set-head origin --auto` when `origin/HEAD` is not set, and `git switch <branch>` when the default branch has no local copy.
- **`pnpm factory` runs in the factory's clone**, so its current directory is the factory itself. Use it only with the target repo as an argument (`pnpm factory refine 12 ../target`); with no argument it refuses to work on the factory. The linked `factory` is the way to run it.

## 5. Optional: watch the runs

Beside `factory run` and `factory stats`, `factory web` shows the run log of the target repo in the browser. It is read-only, runs in the foreground and stops with Ctrl-C:

```sh
factory web [target-repo] [--port <port>]
```

It prints its URL, `http://127.0.0.1:<port>/`, and the home page lists the runs from the most recent to the oldest. Open it before the first run if you like: with no run log it shows an empty page. The page of a run links to the raw log of each attempt and to the full output of each check or criterion that failed, as plain text. It listens only on `127.0.0.1`, reads only `.factory/logs/`, and uses no git, no `gh` and no credential. Its limits and their reasons are in [`design.md`](design.md#web-view).

The commands and their order are in [`design.md`](design.md#commands).
