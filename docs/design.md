# Software factory: design

Status: agreed on 2026-10-23, before the first pilot. The pilot in `askwell` calibrates the values marked as initial.

## Goal

A personal factory that takes a GitHub issue of one of my TypeScript repos and returns a verified pull request that I review and merge.

- Input: a GitHub issue ("What to build" and acceptance criteria).
- Output: a PR with the evidence of each criterion. No automatic merge and no deploy.
- Scope: existing TypeScript repos, one repo per issue. Pilot: `askwell`.
- Out of scope in v1: a loop for the observations of my PR review, new projects from zero, triggers by label or schedule.

## Commands

| Command | What it does |
|---|---|
| `factory refine <n>` | Interactive refinement of issue `<n>` |
| `factory approve <n>` | Approves the spec with a hash |
| `factory run <n>` | Implements, verifies and opens the PR |
| `factory stats` | Summary of the `run.json` files of a repo |

The developer starts each command. Nothing starts on its own.

## Flow

1. **Refine.** `claude` runs in an interactive session in the terminal, on the host, in the worktree of the issue. A refinement skill reads the issue and the code, writes the technical part, and asks only the open decisions (product, ambiguities, doubtful criteria), in rounds, each with a recommended answer. At the end it:
   - rewrites the criteria of the issue with IDs `A1`, `A2`…;
   - writes `specs/<n>.md` on the integration branch;
   - posts a comment on the issue with the decisions and their reasons.
2. **Approve.** `factory approve <n>` writes the date and two hashes in the header of `specs/<n>.md`: one of the criteria of the issue, one of the technical part of the spec. It commits "Approve spec #<n>".
3. **Run.** `factory run <n>` recomputes the hashes. If one differs, it stops and says what changed (fail closed). Then:
   1. The base subtask runs alone, then its gate, then its branch merges into the integration branch.
   2. The other subtasks run in waves, in parallel up to `maxParallel`, each from the integration branch.
   3. Each subtask that passes its gate merges into the integration branch with `git merge`. A conflict blocks the run: it is an error of the refinement, not a task for an agent.
   4. Integrated verification: the checks of the repo and all the criteria, on the integrated app.
   5. A failed criterion sends a follow-up task to the subtask that owns it. Then the integrated verification runs again.
   6. The coordinator opens or updates the PR.

### The spec

The spec has two parts, each where its owner reads it:

- **The issue:** "What to build" and the criteria, with IDs. I decide them.
- **`specs/<n>.md`:** a fixed format that a script parses. It refers to the criteria by ID and never copies them.
  - The file map: the files that each criterion touches.
  - The base subtask: what all criteria share (schema, shared helpers, contracts with a stub body, new dependencies).
  - Each subtask: its criteria, its scope paths, its dependencies.
  - Each criterion: its type of evidence and its level of verification (subtask or integration).

### Partition by scope

The refinement groups the criteria by shared files:

- What all criteria touch goes to the base subtask, which runs first and alone.
- Criteria that share a file go to the same subtask.
- Subtasks in the same wave have disjoint scope paths. A subtask that overlaps another, or depends on it, runs after it.
- An issue with one or two criteria is one subtask, with no base.

Only the base subtask may change the schema, the lockfile, the `package.json` files and the shared registration files (the protected paths of `.factory/config.ts`).

## Verification

### Evidence

Each criterion has one type of evidence:

- **Playwright:** an e2e test that passes.
- **Request:** a request to an endpoint and the comparison of its response with the response the spec expects.
- **Human:** only for a visual or subjective criterion that the refinement cannot convert, with the reason in the spec. The factory attaches Playwright screenshots or a short video. The PR lists these criteria apart and unchecked: I validate them in my review.

A "human" criterion with no reason in the spec means that the refinement is not finished.

### Who writes the tests

- **Request checks:** the base subtask writes them, because it fixes the contracts. The workers cannot change them.
- **Playwright tests:** the worker writes them. At the gate, an independent verifier (OpenCode, clean context) gets only the text of the criterion and the test, checks that the test proves the criterion, and tries to refute it.
- **Existing tests:** a change to a test file that existed before the run is rejected unless I authorize it.

### Two levels

| Level | Who | What | Purpose |
|---|---|---|---|
| Worker | The worker, in its loop | Checks of the repo and its own criteria | Find failures early |
| Gate | The coordinator, not the worker | Runs the checks and the verification of the subtask again on its branch, checks the diff against its scope paths and against the existing tests, runs the independent verifier | Do not trust the report of the worker |
| Integration | The coordinator | Checks of the repo and all the criteria on the integrated app | The evidence of the PR |

The evidence of the PR comes only from the integrated run on the final SHA. A commit after it makes the coordinator generate the evidence again.

## Exit and stop

### A subtask exits when

Its checks and criteria pass and the gate accepts it.

### A subtask stops when

| Rule | Initial value | Applied by |
|---|---|---|
| Patience: attempts in a row with the same error signature (same check, same test or same first error line) | 3 | Coordinator |
| Wall clock, per subtask | 2 h | Coordinator |
| Tokens, per subtask (input without cache, cache creation, output) | 2 M | Coordinator |
| Wall clock, per run | 6 h | Coordinator |
| Tokens, per run | 8 M | Coordinator |

- Patience and the hard limits are different rules. Patience stops a loop with no progress. A hard limit stops a loop that progresses too slowly or costs too much.
- A worker cannot change its own limits.
- A stopped subtask is `blocked`, with the reason and the last failure. The subtasks that do not depend on it go on.

### Plan limit

When the Claude plan limit is reached, the run **pauses**. It is not a failure:

- No new worker starts, and the pause spends no patience.
- The wall clock does not count the time in pause.
- The draft PR gives the reason. I start the run again after the limit resets.
- `maxParallel` goes down by one.

Claude Code reports the plan usage in its `stream-json` output: a `rate_limit_event` gives the status and the utilization of each window (`five_hour`, `seven_day`) with its reset time. The worker layer records it in each attempt.

### Blocks during a run

The coordinator never asks me during a run. It records each block in the PR and goes on with the rest.

| Block | What happens |
|---|---|
| A worker needs a file outside its scope | The coordinator extends the scope only if no subtask of the same wave owns the file and the file is not protected. It records the extension in the run log and in the PR, not in `specs/<n>.md` (the hash stays valid). Otherwise, `blocked`. |
| A question of design or product | `blocked`. The factory never decides a requirement. I change the spec, approve it again and start the run again. |
| Patience, a limit or the environment | `blocked`, with the reason. |

A macOS notification links to the PR when a run ends, pauses or blocks.

### Output of a run

- **All criteria pass** (except the "human" ones): the coordinator marks the PR "ready for review". Only the coordinator does this.
- **Anything else:** a draft PR with the real state: the evidence of the criteria that pass, each blocked subtask with its reason and its last failure, and what it needs to continue.

The issue, `specs/<n>.md` and the PR are the records. A new session starts again from them, not from a conversation.

## Architecture

### Repositories

- **`software-factory`** (this repo): the coordinator, the gates, the worker layer, the skills (refinement, independent verifier), the prompts and the `factory` CLI. It takes the target repo as an argument.
- **Each target repo:** a `.factory/` folder:
  - `config.ts`: checks, app start, e2e commands, environment, protected paths, `maxParallel`. It uses the types that this repo exports.
  - `Dockerfile`: the image of the workers of that repo.
  - `.env.example`, and `.env` in `.gitignore`.
  - `logs/` and `worktrees/`, in `.gitignore`.

The factory does not change the `package.json` of a target repo.

### Coordinator

- TypeScript, deterministic. It makes no LLM call.
- The gates, the patience and the limits are pure functions, apart from the loop.
- Its state comes from the issue, `specs/<n>.md` and the PR.

### Worker layer

- Written from zero in this repo, behind the interface `WorkerRunner`.
- A fake `WorkerRunner` tests the coordinator with no Docker and no plan usage.
- Each worker runs in its own Docker container, with a bind mount of its worktree, on its own branch.
- Each container gets only:
  - its token;
  - the URL of a Neon branch for tests;
  - its own `E2E_PORT`.
- No container has:
  - the `.env` of the repo;
  - `~/.ssh`;
  - the `gh` session;
  - other repos.
- Only the coordinator, on the host, pushes and opens PRs.
- The layer must give the coordinator:
  - start a worker on a branch;
  - stop it at a deadline, and keep its worktree;
  - run a command in its environment and get the exit code;
  - read its token usage;
  - detect the error of the plan limit;
  - collect its commits.
- **Sandcastle (`mattpocock/sandcastle`) is a design reference only.** We read its documentation and its code to see how it solves a problem before we write ours. We do not install it, run it or copy its code.
- A toy repo with trivial tasks tests the layer before `askwell`.

### Agents and authentication

Only subscriptions, no paid API calls.

| Role | Agent | Authentication |
|---|---|---|
| Refinement | Claude Code CLI, interactive, on the host | My Claude session |
| Base subtask and workers | Claude Code CLI, in Docker | `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (Max 5x) |
| Independent verifier | OpenCode CLI, in Docker | OpenCode Go key, with Extra Usage off. Only models of the `opencode-go/` provider: `opencode/` is the pay-per-use Console |

These are not used:

- **Mastra and the Claude Agent SDK.** They need a paid API key, or a Claude.ai sign-in in a third-party app, which Anthropic does not permit.
- **Claude models through OpenCode.** Anthropic and OpenCode both forbid it.

### Parallelism

| Setting | Rule |
|---|---|
| `maxParallel` at the start | 1 |
| Up by one | After 3 runs in a row with no failure of the worker layer |
| Ceiling | 2 Claude workers. 3 only after several runs with 2 and no pause for the plan limit |
| Down by one | On each pause for the plan limit |

The independent verifier (OpenCode) does not count for this ceiling.

### Git

- The integration branch is `factory/<n>-<slug>`, from `main`. The PR goes to `main`.
- Each subtask has its own branch from the integration branch.

## Measurement

Each run writes `.factory/logs/<run-id>/run.json`, outside git:

- **Result:** ready, draft with blocks, or paused. The criteria that pass, the blocked ones and the human ones.
- **Cost:** tokens per subtask and per run, attempts per subtask, wall clock with no pauses.
- **Friction:**
  - blocks by type (scope, design question, patience, limit, environment);
  - automatic scope extensions;
  - rejections by the gate and by the verifier;
  - conflicts at integration (expected: 0).
- **Failures of the worker layer**, apart from the failures of the design:
  - the container does not start;
  - the end of the agent is not detected;
  - a process hangs;
  - commits or cleanup fail;
  - the token usage cannot be read.
- **Logs:** the path to the raw log of each attempt.
- **Quality, after the merge:** changes I made at review, and escapes (bugs that the verification did not find).

`factory stats` summarizes these files for a repo.

## To verify in the pilot

- [x] OpenCode Go authenticates in a container with no pay-per-use fallback. `opencode run --standalone` reads `OPENCODE_API_KEY` from the environment of the container, with no `auth login` and no `auth.json`. With no active Go subscription, the request fails with a 403 and does not fall back to the Console. Verified on 2026-10-24 with OpenCode 2.0.16 and `opencode-go/beam-free`.
- [ ] How the Claude Code CLI reports a rejected request at the plan limit. The plan usage is known (`rate_limit_event`); the exact form of a rejection is not seen yet.
- [x] One `setup-token` token works in 2 containers at the same time. Verified on 2026-10-24 with the Docker test that runs when `CLAUDE_CODE_OAUTH_TOKEN` is set.
- [ ] The `askwell` image: `pnpm`, Playwright with Chromium, access to Neon branches, one `E2E_PORT` per worker.
- [ ] The initial values of patience, limits and parallelism.
