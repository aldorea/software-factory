# Onboarding: run the factory on a target repo

How to install the `factory` CLI once and prepare any TypeScript repo to use it. For what the factory does and why, see [`design.md`](design.md); for the terms, [`../GLOSSARY.md`](../GLOSSARY.md).

## What you need on the host

- Node 24 (`engines` in [`package.json`](../package.json) has the exact floor), pnpm, Docker and the GitHub CLI `gh`, signed in (`gh auth login`).
- The Claude Code CLI, `claude`, signed in: the refinement runs it on the host.
- The credential of each agent that a run will use, in the environment of the shell that starts `factory`, not in `.factory/.env`: `CLAUDE_CODE_OAUTH_TOKEN` and, for OpenCode Go, `OPENCODE_API_KEY`. See [ADR 0001](adr/0001-subscriptions-only.md).

`factory run` checks Docker and `gh` first and reports every missing tool before it asks anything.

## 1. Install the CLI

The factory is a local clone that you link, not a published package. From the clone:

```sh
pnpm link --global
```

`factory` is then on your PATH, under the Node of your shell. The bin is TypeScript that Node 24 runs as it is, so there is no build step. If `pnpm link --global` complains that there is no global bin directory, run `pnpm setup` and open a new shell.

## 2. Build the images, base first

Each worker runs in a container. The base image holds the agents; the image of a target repo starts `FROM` it and adds what that repo needs. Build them in this order, and rebuild the target repo's image after every rebuild of the base, or the change never reaches it.

1. The base image, from the clone: `pnpm image:build` (it tags `software-factory/worker:dev`, with your user and group ids so that bind-mounted worktrees stay yours).
2. The target repo's image, after `factory init` has written its `.factory/Dockerfile` (step 3): `docker build -t <image> .factory` from the root of the target repo, where `<image>` is the `image` field of `.factory/config.ts`.

## 3. Prepare the target repo

From the root of the target repo:

```sh
factory init
```

It stops with a message when the folder is not the root of a git repo, or the repo has no `origin` remote. It writes the files of `.factory/` that are missing, adds `.factory/logs/`, `.factory/worktrees/` and `.factory/.env` to `.gitignore` when they are not there, and lists each file as written or skipped. It never overwrites a file, so you can run it again on a half-prepared repo, and it never touches the repo's `package.json`. The templates are in [`src/init/templates.ts`](../src/init/templates.ts) and the decisions in [`src/init/plan.ts`](../src/init/plan.ts).

What the generated files assume, and what you may need to change:

- **Checks.** The first check installs the dependencies in a fresh worktree, with the command that the lockfile implies: only `pnpm-lock.yaml` (`pnpm install --frozen-lockfile`) and `package-lock.json` (`npm ci`) are recognised. After it come the `lint`, `typecheck` and `test` scripts of the repo's `package.json` that exist. A config with no checks is rejected when it loads.
- **No recognised lockfile (yarn, or none).** `init` writes no install check, and its Dockerfile is the npm one, with no other package manager added. Add an install check as the first one, and make sure `.factory/Dockerfile` provides the package manager it uses. Without the install check the worktree has no `node_modules` and every later check fails.
- **The config imports nothing from the factory** and reads `.factory/.env` itself, with Node's own parser. It fails with a message naming the file or the variable that is missing. Copy `.factory/.env.example` to `.factory/.env` and fill it in.
- **The database variable.** The generated `environment` gives each worker slot its own `E2E_PORT` and its own `FACTORY_E2E_DATABASE_URL_<slot>` from `.env`. `.env.example` lists one variable for each slot that the default parallelism ceiling can reach (2 today): if you raise `maxParallelCeiling` in the config, add a variable for each new slot. A repo with no database removes that variable from the config and from `.env.example`; otherwise the run fails on the missing value.
- **The image name** is `<repo folder>-factory-worker:dev`, with the folder name cut to the characters that Docker allows.
- **Evidence and app.** The generated config has no `app` and no `evidence` commands. Add them before a run that has Playwright or request criteria: a criterion whose type has no command stops the run before any worker starts.
- **Anything else the image needs** (Playwright, a browser) goes in `.factory/Dockerfile`.
- **The pnpm store stays outside the worktree.** The worktree is a bind mount, so pnpm would put its store inside it, leave the worktree dirty and keep the subtask branch checked out. The generated pnpm Dockerfile sets `npm_config_store_dir=/home/agent/.pnpm-store`; a Dockerfile written by hand needs the same line.

A mistake in the config is reported field by field when it loads. `factory validate <issue>` loads it too.

## 4. Where and how to run the commands

- **Run every command from the root of the target repo, never from a worktree.** The target repo is the current directory, or the last argument. The run logs go to `.factory/logs/` of that directory, and `factory stats` reads them there; from a worktree they land in the worktree.
- **Update the default branch before `factory refine`.** The integration branch starts from your local copy of the default branch (the branch that `origin/HEAD` points to), and the factory never fetches. Check it out and pull it first, or the spec starts from old code, and local commits on it are included. The command stops with the fix when it cannot resolve the branch: `git remote set-head origin --auto` when `origin/HEAD` is not set, and `git switch <branch>` when the default branch has no local copy.
- **`pnpm factory` runs in the factory's clone**, so its current directory is the factory itself. Use it only with the target repo as an argument (`pnpm factory refine 12 ../target`); with no argument it works on the factory. The linked `factory` has no such trap, and is the way to run it.

## 5. Optional: watch the runs

Beside `factory run` and `factory stats`, `factory web` shows the run log of the target repo in the browser. It is read-only, runs in the foreground and stops with Ctrl-C:

```sh
factory web [target-repo] [--port <port>]
```

It prints its URL, `http://127.0.0.1:<port>/`, and the home page lists the runs from the most recent to the oldest. Open it before the first run if you like: with no run log it shows an empty page. The page of a run links to the raw log of each attempt and to the full output of each check or criterion that failed, as plain text. It listens only on `127.0.0.1`, reads only `.factory/logs/`, and uses no git, no `gh` and no credential. Its limits and their reasons are in [`design.md`](design.md#web-view).

The commands and their order are in [`design.md`](design.md#commands).
