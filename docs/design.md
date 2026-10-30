# Software factory: design

Status: agreed on 2026-10-23, before the first pilot. The pilot in `askwell` calibrates the values marked as initial. The open questions of the pilot are GitHub issues.

## Goal

A personal factory that takes a GitHub issue of one of my TypeScript repos and returns a verified pull request that I review and merge.

- Input: a GitHub issue ("What to build" and acceptance criteria).
- Output: a PR with the evidence of each criterion. No automatic merge and no deploy.
- Scope: existing TypeScript repos, one repo per issue. Pilot: `askwell`.
- Out of scope in v1: a loop for the observations of my PR review, new projects from zero, triggers by label or schedule.

## Commands

| Command | What it does |
|---|---|
| `factory refine <n> [--refinement-agent <agent>:<model>]` | Interactive refinement of issue `<n>` |
| `factory validate <n>` | Checks `specs/<n>.md` on the integration branch against the issue and the config, and changes nothing |
| `factory approve <n>` | Validates the spec and approves it with a hash |
| `factory run <n>` | Implements, verifies and opens the PR |
| `factory stats` | Summary of the `run.json` files of a repo |
| `factory web [target-repo] [--port <port>]` | Local read-only web view of the run log of a repo |
| `factory init` | Prepares `.factory/` in a target repo |
| `factory auth [agent] [--force]` | Saves the credential of an agent, once for every target repo |
| `factory image [target-repo]` | Builds the base image, then the worker image of the target repo, with `.factory/` as its build context |
| `factory doctor [target-repo]` | Checks that the host and the target repo are ready for any issue, and changes nothing |

The target repo is the current directory, or the last argument. The developer starts each command. Nothing starts on its own. Every command refuses to work on the factory itself or on a folder inside `.factory/worktrees/` of a repo, because its run log would land there. To set a repo up, see the [onboarding guide](onboarding.md).

Before `factory run` starts, the developer chooses the agent and the model of each role: the workers, the independent verifier and the acceptance tester. The choice comes from the flags (`--worker-agent`, `--verifier-agent`, `--tester-agent`); else, in a terminal, from a menu; else from that default. With none of them, the command refuses to start. The prompt comes only before a run starts or when it resumes, never during it. See [ADR 0003](adr/0003-interchangeable-agents.md).

The menu opens on a summary with the choice of every role, by its name in the glossary, each with its origin: `.factory/config.ts`, the paused run that resumes, a flag, or `chosen` for a value the developer changed in the menu. Enter starts. ↑/↓ selects a role that no flag fixed and → opens its step, which lists agent and model pairs with the current choice selected and an entry per agent to type another model; ← or Esc goes back to the summary and keeps the choice. Ctrl-C cancels and starts nothing. A step shows an agent with no credential as `opencode (no credential · → to add)`; choosing it opens the prompt of `factory auth` for that agent and, once the credential is saved, goes back to the step. With no terminal, a chosen agent with no credential fails the readiness check before the run starts. With a terminal, only the agents chosen by a flag are checked before the menu: a role that comes from the config or from a paused run is not blocked there, so the menu shows `→ to add` and lets the developer switch agent or add the credential; the check after the menu requires the credential of every role the run needs (see [Readiness](#readiness)). When the paused run reached the plan limit of an agent that the summary still holds and `now` is before its `resetsAt`, the summary warns that the run will pause again:

```
❯ workers:               claude-code opus (paused run)
  ⚠ claude-code plan limit until 14:00: the run will pause again
  independent verifier:  opencode opencode-go/glm-5.3 (config)
  acceptance tester:     claude-code sonnet (flag)
Enter to start · → to change a role
```

Before `factory refine` starts, the developer chooses the agent and the model of the refinement the same way: from `--refinement-agent`, else in a terminal from the same menu with one role, else from `roles.refinement` of `.factory/config.ts`. Only Claude Code is offered until the refinement skill works on another agent ([ADR 0003](adr/0003-interchangeable-agents.md)).

### Readiness

One set of checks tells whether the host and the target repo are ready. `factory doctor` runs all of them and lists every problem; each command runs the ones it needs before it does anything:

| Command | Checks before it starts |
|---|---|
| `factory refine` | `gh` signed in, the Claude session of the host (`claude auth status`), `origin/HEAD` resolved |
| `factory run` | Docker running, `gh` signed in, the credential of the agent of each role the spec needs, the worker image present and built from the current base image |
| `factory doctor` | All of the above, Node, the config loads, `.factory/.env` has every value the config reads, `.factory/.dockerignore` excludes `.env`, and the credential of each agent the config's roles use |

`factory run` asks for a credential only for the roles the spec needs: the workers always, the independent verifier only when a criterion has `playwright` evidence, and the acceptance tester only when a criterion has evidence other than `human`. This is the rule of the run itself, so a spec with no automatic criteria runs with no credential for the tester. When the spec cannot be read at that point, every role counts, and the run reports the spec problem right after. `factory doctor` has no issue, so it checks every agent that a role of the config uses.

With a terminal, `factory run` checks before the role menu only the credentials of the agents that a flag chose; the roles of the config or of a paused run wait for the menu, where the developer can switch agent or add the credential. After the menu it checks the credential of every role the spec needs. With no terminal it checks everything before it starts.

The worker image is built with `.factory/` as its context, so `.factory/.env` must not reach the build. `factory doctor` and `factory image` fail closed when `.factory/.dockerignore` is missing (the fix is `factory init`) or does not exclude `.env` (the fix is to add the line: `factory init` never overwrites the file).

What depends on one issue, such as a criterion whose type has no evidence command, stays in `factory validate <n>`. A command reports every problem it finds, not only the first, and each problem names the command that fixes it:

```
✗ OPENCODE_API_KEY not set; roles.verifier uses opencode → factory auth opencode
✗ mi-repo-factory-worker:dev built from an older base image → factory image
✗ origin/HEAD not set → git remote set-head origin --auto
```

`factory doctor` exits with 1 when it finds a problem and 0 otherwise.

### Setup

- **Init.** `factory init` writes the files of `.factory/` that are missing, including `.factory/.dockerignore`, which excludes `.env` from the build context of the worker image, and the default agent and model of each role: Claude Code for all of them, `opus` for the refinement and the independent verifier, `sonnet` for the workers and the acceptance tester, so that the verifier's model differs from the workers'. It ends with the steps left, adapted to the repo, and marks with `✓` the ones already done:

  ```
  Next:
    1. fill .factory/.env (copy of .env.example: FACTORY_E2E_DATABASE_URL_1, _2)
    2. factory auth          set the credential of each agent, once for every repo
    3. factory image         build the base image and mi-repo-factory-worker:dev
    4. factory doctor        check that everything is ready
    5. factory refine <n>
  ```

- **Images.** `factory image` always builds the base image from the factory, with the developer's user and group ids, then the worker image with the `image` name of the config, from `.factory/Dockerfile` and with `.factory/` as the build context, still with `--build-arg BASE_IMAGE=<base tag>`. The command stops before any build when `.factory/.dockerignore` is missing or does not exclude `.env`. Docker's cache makes the base image free when nothing changed. The worker image carries a label with the id of the base image it was built from. A worker image with no such label, or with the id of an older base image, fails the readiness check of `factory run` closed. `pnpm image:build` stays for the factory's own Docker tests.
- **Credentials.** See [Agents and authentication](#agents-and-authentication).
- **Colours.** The output of `init`, `auth`, `image`, `doctor` and of the readiness checks uses strong colours, in bold and bright: green `✓` for a step done or a check passed, red `✗` for a problem, yellow `⚠` for a warning that does not block, cyan for each command to type (after `→` and in `Next:`), and bold titles. Colour goes out only when the output is a terminal and `NO_COLOR` is not set; otherwise the same lines go out as plain text. The output during a run keeps its own colours (see [Blocks during a run](#blocks-during-a-run)).

## Flow

1. **Refine.** The agent of the refinement runs with the chosen model in an interactive session in the terminal, on the host, in the worktree of the issue. A refinement skill reads the issue and the code, writes the technical part, and asks only the open decisions (product, ambiguities, doubtful criteria), in rounds, each with a recommended answer. At the end it:
   - rewrites the criteria of the issue with IDs `A1`, `A2`…;
   - writes `specs/<n>.md` on the integration branch;
   - posts a comment on the issue with the decisions and their reasons.
2. **Approve.** `factory approve <n>` writes the date and two hashes in the header of `specs/<n>.md`: one of the criteria of the issue, one of the technical part of the spec. It commits "Approve spec #<n>".
3. **Run.** `factory run <n>` recomputes the hashes. If one differs, it stops and says what changed (fail closed). Then:
   1. The base subtask runs alone, then its gate, then its branch merges into the integration branch.
   2. The other subtasks run in waves, in parallel up to `maxParallel`, each from the integration branch.
   3. Each subtask that passes its gate merges into the integration branch with `git merge`. A conflict blocks the run: it is an error of the refinement, not a task for an agent.
   4. Integrated verification: the checks of the repo and all the criteria, on the integrated app. When they pass, the acceptance tester uses the app against every automatic criterion.
   5. A failed criterion, by its command or by the acceptance tester, sends a follow-up task to the subtask that owns it. Then the integrated verification runs again.
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

The coordinator publishes these attachments on the **evidence branch** `factory-evidence/<n>`, because a path under `.factory/logs/` is outside git and a reviewer on GitHub cannot open it:

- After the integrated verification, the coordinator, on the host, commits the attachments of each human criterion under `<run-id>/<criterion-id>/` and pushes the branch as it pushes the integration branch. No container pushes.
- The branch has no common history with the default branch and is never merged.
- A run adds a commit on top of the branch and never rewrites the earlier ones. The PR links each human criterion to its files at the pushed commit, so the links keep working after later runs. Images render inline.
- A run with no attachments does not create the branch.
- A failure to publish is recorded in `run.json` (`evidence.failure`), stated in the PR, and keeps the PR a draft.

A "human" criterion with no reason in the spec means that the refinement is not finished.

`.factory/config.ts` gives the Playwright and request commands with the placeholder `{{id}}` for the criterion ID (the test or request carries the ID in its title) and the folder where Playwright leaves its screenshots and videos. A criterion whose type has no command in the config stops the run before any worker starts.

### Who writes the tests

- **Request checks:** the base subtask writes them, because it fixes the contracts. The workers cannot change them.
- **Playwright tests:** the worker writes them. At the gate, an independent verifier, in its own clean context, gets only the text of the criterion and the test, checks that the test proves the criterion, and tries to refute it.
- **Existing tests:** a change to a test file that existed before the run is rejected unless I authorize it.

### Acceptance tester

The tests above come from the workers, and the independent verifier only reads them. The acceptance tester checks the app itself, the way a user would (see [ADR 0004](adr/0004-acceptance-tester.md)):

- It runs in each round of the integrated verification, only when the checks and the automatic criteria already pass.
- It tests every Playwright and request criterion of the run, also after a follow-up, and never a human one.
- It receives only the text of the criteria and the running app. Its prompt forbids reading the diff, the pull request and the tests of the workers; the container cannot enforce it, because the app starts from the code.
- For each criterion it returns a verdict, what it did and saw, and the paths of the files of its evidence (its scripts, screenshots and output), written in a folder outside the worktree.
- A criterion it fails counts as a failed criterion: it sends a follow-up task with the observation and its evidence to the subtask that owns it, under the same patience and limits.
- In the PR, each automatic criterion shows both proofs: the result of its command and the observation of the tester, with a link to its files. Its screenshots go to the evidence branch, as the attachments of the human criteria do.

### Two levels

| Level | Who | What | Purpose |
|---|---|---|---|
| Worker | The worker, in its loop | Checks of the repo and its own criteria | Find failures early |
| Gate | The coordinator, not the worker | Runs the checks and the verification of the subtask again on its branch, checks the diff against its scope paths and against the existing tests, runs the independent verifier | Do not trust the report of the worker |
| Integration | The coordinator, then the acceptance tester | Checks of the repo and all the criteria on the integrated app, then the tester's own use of the app against the automatic criteria | The evidence of the PR |

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

- The token limits are set per agent in `.factory/config.ts`, because each provider counts tokens differently. The values above are the initial ones for Claude Code; each other agent gets its own initial values, calibrated in the pilot. A run that changes the agent of its workers on resume counts the tokens of each agent against that agent's limit. The answers of the independent verifier and the work of the acceptance tester count in the run limit of their agent, and not in the limit of a subtask. The wall clock and patience do not depend on the agent.
- Patience and the hard limits are different rules. Patience stops a loop with no progress. A hard limit stops a loop that progresses too slowly or costs too much.
- A worker cannot change its own limits.
- A follow-up task is more work on the same subtask: it keeps counting the patience, the tokens and the wall clock of its subtask.
- The limits per run also stop the follow-up tasks. The time in pause does not count.
- A stopped subtask is `blocked`, with the reason and the last failure. The subtasks that do not depend on it go on.
- The reason of a failure goes back to the worker in both loops: the next attempt after a gate rejection, and the follow-up task after the integrated verification. For each check and criterion that failed, the prompt carries the end of its output: its last 40 lines, without colors, at most 4 KB. These initial values are calibrated in the pilot.

### Plan limit

When the plan limit of any agent of the run is reached (the workers', the independent verifier's or the acceptance tester's), the run **pauses**. It is not a failure:

- No new worker starts, and the pause spends no patience.
- The wall clock does not count the time in pause.
- The draft PR gives the reason. I start the run again after the limit resets.
- The `maxParallel` of that agent goes down by one.

When I resume a paused run, `factory run` asks again for the agent and the model of each role, with the previous choice selected. I may change them: patience keeps counting, because the error signature does not depend on the agent.

The coordinator finds what to resume in two records, never in a conversation:

- **Merged subtasks:** the `Factory-Subtask` trailers of the merge commits on the integration branch. A subtask merged by any earlier run does not run again.
- **The paused run:** the latest `run.json` of the issue. When its result is `paused`, the run continues with the same run ID: the time in pause comes from it, and each paused subtask continues with the patience, tokens and wall clock it carried. A subtask blocked before the pause stays blocked. With no `run.json`, or a latest one that is not paused, a new run starts, and every subtask that has not merged starts again.

Each agent's adapter reads its plan usage. Claude Code reports it in its `stream-json` output: a `rate_limit_event` gives the status and the utilization of each window (`five_hour`, `seven_day`) with its reset time. The worker layer records it in each attempt.

OpenCode Go reports its usage limit as an `error` event whose `error.type` is `provider.quota`, or whose response body names `GoUsageLimitError`, and `opencode run` exits without retrying. The adapter reads it as a plan limit that resets after the `retryAfterMs` of the event, when it comes. The event shape comes from the tests of the OpenCode repo, not from a captured run: the first run that hits the limit must capture it and replace the fixture.

### Blocks during a run

The coordinator never asks me during a run. It records each block in the PR and goes on with the rest.

| Block | What happens |
|---|---|
| A worker needs a file outside its scope | The coordinator extends the scope only if no subtask of the same wave owns the file and the file is not protected. It records the extension in the run log and in the PR, not in `specs/<n>.md` (the hash stays valid). Otherwise, `blocked`. |
| A question of design or product | `blocked`. The factory never decides a requirement. I change the spec, approve it again and start the run again. |
| Patience, a limit or the environment (for example, the app does not become ready) | `blocked`, with the reason. |
| A check of the repo fails in the integrated verification while every criterion passes | No subtask owns it, so the coordinator sends no follow-up task and guesses no owner: such a failure is usually a gap in the refinement. The run ends with a draft PR and an `integration-check` block in `run.json` and in the PR, with the check, the SHA of the integration branch and the end of its output. When criteria fail too, their follow-up tasks carry the failed checks instead. |

A macOS notification links to the PR when a run ends, pauses or blocks. Before the run starts, `factory run` prints the URL of `factory web`, and a notice when the last run of the issue is abandoned (see [Web view](#web-view)). While the run works, it prints two kinds of line to the terminal, each with the time (`hh:mm:ss`):

- **Progress:** one line for each change of `run.json` that a developer watches: a subtask that changes state, a finished attempt, the integrated verification, a pause, the result and the PR. Its colour follows the result: green for merged, red for blocked, yellow for paused.
- **Activity:** one line for each event of the activity of an attempt, of an independent verifier question or of the acceptance tester, with its prefix in a colour of its own and the rest dimmed. The prefix is the subtask (`S2`), `verifier` and the criterion (`verifier A3`) for the independent verifier, or `tester` for the acceptance tester: the short key of the role in the flags and the config, not its name in the glossary, so that the lines stay aligned. An event is a message of the agent (its first line, cut to about 100 characters), a tool with its target (`Edit src/api/users.ts`, `Bash pnpm test`) or the end of the attempt. The CLI filters none of them; the raw log keeps everything.

In a terminal, one last line stays at the bottom and is redrawn every second: each attempt in progress, its duration and the time since its last activity, so that an agent that thinks for minutes does not look dead. When the output is not a terminal, the same lines go out with no colour and no bottom line. The run ends with a short summary: the result, the subtasks merged and blocked, the wall clock, the tokens and the URL of the PR.

The activity is only shown: nobody talks to an agent during an attempt, and it never changes the run.

### Output of a run

- **All criteria pass** (except the "human" ones): the coordinator marks the PR "ready for review". Only the coordinator does this.
- **Anything else:** a draft PR with the real state: the evidence of the criteria that pass, each blocked subtask with its reason and its last failure, and what it needs to continue.

The PR names the agent and the model of each role, and any change on resume. When the independent verifier or the acceptance tester used the same model as the workers, the PR says so in one line: its independence then rests on its clean context alone.

The issue, `specs/<n>.md` and the PR are the records. A new session starts again from them, not from a conversation.

## Architecture

### Repositories

- **`software-factory`** (this repo): the coordinator, the gates, the worker layer, the skills (refinement, independent verifier), the prompts and the `factory` CLI. It takes the target repo as an argument.
- **Each target repo:** a `.factory/` folder:
  - `config.ts`: checks, app start and the command that tells when the app is ready, e2e commands, environment, protected paths, the default agent and model of each role, and per agent its token limits and `maxParallel`. It imports nothing from this repo, so it works wherever the two repos live, and the factory validates it when it loads and reports each mistake by field. It reads its own `.factory/.env` and fails with a clear message when a value is missing: the factory never loads `.env`, and only the values that `environment` returns reach a container.
  - `Dockerfile`: the worker image of that repo, from the factory's base image.
  - `.env.example`, and `.env` in `.gitignore`.
  - `package.json` with `"type": "module"`, so that the config loads as an ES module.
  - `logs/` and `worktrees/`, in `.gitignore`.

`factory init` writes the files that are missing, never overwrites one, and the factory does not change the `package.json` of a target repo.

### Coordinator

- TypeScript, deterministic. It makes no LLM call.
- The gates, the patience and the limits are pure functions, apart from the loop.
- Its state comes from the issue, `specs/<n>.md` and the PR.

### Worker layer

- Written from zero in this repo, behind the interface `WorkerRunner`.
- A fake `WorkerRunner` tests the coordinator with no Docker and no plan usage.
- Each worker runs in its own Docker container, with a bind mount of its worktree, on its own branch.
- Each container gets only:
  - the credential of its agent;
  - the URL of a Neon branch for tests;
  - its own `E2E_PORT`.
- The independent verifier runs in a container of the same image, created for one question and removed after it:
  - with no bind mount: it gets the text of the criterion and the test in the prompt;
  - with its own clean context, never shared with the workers, even when it runs their agent and model;
  - with only the credential of its agent;
  - with every tool denied, in an empty directory. For OpenCode, a config denies them; if OpenCode does not load the config, the run fails closed.
  - The container is the second barrier: a tool that escaped the config reaches only a container that is removed.
- The acceptance tester runs in a container of the same image, created for one round of the integrated verification and removed after it:
  - with a bind mount of a worktree of the integration branch at the verified SHA, only to start the app;
  - with its own clean context, never shared with the workers, even when it runs their agent and model;
  - with the credential of its agent, the URL of a Neon branch and its own `E2E_PORT`, as a worker;
  - with its tools, because it uses the app; its evidence goes to a folder outside the worktree, which the coordinator copies to the log of the run.
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
  - collect its commits;
  - ask the independent verifier and get its answer, or an error if it used a tool or gave no answer;
  - start the acceptance tester on the integrated app and get its verdict per criterion with the paths of its evidence, or an error if it gave no usable report.
- Each agent has an adapter in the layer. An agent can serve as the workers only if its adapter reads its token usage and detects its plan limit, as the acceptance tester only if its adapter reads its token usage, as the independent verifier only if every tool can be denied to it with a fail-closed check, and as the refinement only if its adapter starts the refinement skill in an interactive session on the host. An agent that misses one is not offered for that role.
- Each adapter turns the lines of its agent's stream into the common events of the activity: a message, a tool with its target, the end. It gives only what its stream holds: the `--format json` stream of OpenCode 2.0.16 has `tool_use` events (`read`, `shell`, `grep`, `edit`, with the input of the tool in `part.state.input`), so OpenCode shows messages, tools and the end. The target of a tool is the path relative to the worktree, the command or the pattern, as for Claude Code, and the adapter learns the worktree from the worker, because the stream does not carry it.
- Sandcastle (`mattpocock/sandcastle`) is a design reference only: see [ADR 0002](adr/0002-own-worker-layer.md).
- A toy repo with trivial tasks tests the layer before `askwell`.

### Agents and authentication

Only subscriptions, no paid API calls: see [ADR 0001](adr/0001-subscriptions-only.md) for the conditions an agent must meet and the options this rules out. The agents are interchangeable: I choose the agent and the model of each role before a run (see [Commands](#commands) and [ADR 0003](adr/0003-interchangeable-agents.md)).

| Agent | Authentication |
|---|---|
| Claude Code CLI | In Docker: `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (Max 5x). On the host, for the refinement: my Claude session |
| OpenCode CLI | `OPENCODE_API_KEY`: an OpenCode Go key, with Extra Usage off. Only models of the `opencode-go/` provider: `opencode/` is the pay-per-use Console |

The developer sets the credential of each agent once, and it serves every target repo. For each agent, the factory takes its environment variable when it is set and not empty; otherwise it reads the credentials file of the developer. Nothing of a target repo holds a credential: `.factory/.env` is for the values of the app only.

- **The file.** `~/.config/software-factory/credentials`, or `$XDG_CONFIG_HOME/software-factory/credentials` when that variable is set. It holds one `VARIABLE=value` line per saved agent, with the names of the environment variables, and nothing else. Its folder has mode `0700` and the file mode `0600`. The factory reads it with Node's env parser and runs nothing from it.
- **Fail closed.** When the file can be read by anyone but the developer, every command that reads it stops and names the fix (`chmod 600 <path>`); it never changes the mode itself. A line it cannot parse stops it too.
- **`factory auth`.** With no argument it opens a menu with the agents, the variable of each and where its credential comes from: `saved (…a1f3)`, `from environment (wins over saved)` or `not set`. Enter sets a credential, `d` deletes the saved one, Esc quits. `factory auth <agent>` goes straight to the prompt of that agent; with no terminal it reads one line from stdin (`pbpaste | factory auth claude-code`), and with no terminal and no agent it prints its help.
- **The prompt explains itself.** Before it asks, it says what the credential is and which roles use it, how to get it (`claude setup-token` on a Max plan; an OpenCode Go key with Extra Usage off), where it is saved and that it serves every target repo, and that an environment variable of the same name wins. The input is not echoed, and a saved value shows only its last 4 characters. `factory auth --help` and the message of a missing credential say the same, one line each.
- **What it checks.** No call to the agent: that would spend the plan and needs Docker; the first attempt is the real check. It refuses an empty value or one with a space or a line break, because it would break the env file of the container. It also refuses a `#`, a quote (single or double), a backtick or a backslash, because Node's env parser, which reads the credentials file and the env file of the container, would truncate the value at a `#` or unquote it. It warns when a Claude Code token does not start with `sk-ant-oat`, and in a terminal saves only if the developer confirms. With no terminal nobody can confirm, so the token is refused unless `factory auth <agent> --force` is given: it then saves the token and prints a `⚠` line. `--force` never bypasses the refusals above, and in a terminal the confirm prompt stays.
- **The write.** It changes or adds only the line of that agent, writes the result to a temporary file of mode `0600` in the same folder and renames it over the old one, so a half-written file never exists.
- **To a container.** As before: the credential of the agent of the role goes in an env file of mode `0600`, removed in a `finally`.

| Role | Agents it can use |
|---|---|
| Refinement | Claude Code (the only agent offered), interactive, on the host, with the chosen model |
| Base subtask and workers | Claude Code or OpenCode Go, in Docker |
| Independent verifier | Claude Code or OpenCode Go, in Docker, with every tool denied by a fail-closed check |
| Acceptance tester | Claude Code or OpenCode Go, in Docker |

The workers, the independent verifier and the acceptance tester may use the same agent and the same model. Each still runs in its own container with its own clean context.

Verified on 2026-10-24:

- One `setup-token` token works in 2 containers at the same time.
- `opencode run --standalone` reads `OPENCODE_API_KEY` from the environment of the container, with no `auth login` and no `auth.json`. With no active Go subscription, the request fails with a 403 and does not fall back to the Console (OpenCode 2.0.16, `opencode-go/beam-free`).
- The `--format json` stream of OpenCode 2.0.16 holds `step_start`, `step_finish`, `text` and `tool_use` events (`opencode-go/glm-5.3`); the adapter does not read token usage from it. Every line carries `sessionID`. `opencode session export --standalone <sessionID>`, run in the same environment after the process ends, prints JSON whose `info.tokens` is `{input, output, reasoning, cache: {read, write}}`. The adapter reads the usage from that export: `input` is the input, `cache.write` the cache creation, `cache.read` the cache read, and `output` plus `reasoning` the output. The same read serves the workers and the independent verifier. The verifier reads it after its directory check, so the export is never a leftover. When the usage cannot be read, the attempt fails with a `usage-unreadable` failure of the worker layer; for a verifier answer, the verdict stays and the same failure is recorded.

### Parallelism

Each agent has its own `maxParallel` and ceiling, because each runs on its own subscription.

| Setting | Rule |
|---|---|
| `maxParallel` at the start | 1 |
| Up by one | After 3 runs in a row of that agent with no failure of the worker layer |
| Ceiling | Claude Code: 2 workers. Other agents: an initial value, calibrated in the pilot |
| Down by one | On each pause for the plan limit of that agent |

The independent verifier and the acceptance tester do not count for this ceiling.

### Git

- The **default branch** of a target repo is the one that `origin/HEAD` points to. The integration branch is `factory/<n>-<slug>`, from its local copy, and the PR goes to the default branch. The factory never fetches: the developer updates the default branch before `factory refine`.
- A missing `origin/HEAD` stops `refine` and `run` with the command that sets it (`git remote set-head origin --auto`). A default branch with no local copy stops them with a message of its own.
- Each subtask has its own branch from the integration branch.
- Before the PR is ready, the integration branch must contain the local head of the default branch. When the default branch moved during the run, the coordinator merges it and runs the integrated verification again on the result. A conflict blocks the run with a `default-branch-conflict` block in `run.json` and in the PR, and counts as a conflict at integration.

## Measurement

Each run writes `.factory/logs/<run-id>/run.json`, outside git:

- **Result:** ready, draft with blocks, or paused. The criteria that pass, the blocked ones and the human ones.
- **Agents:** the agent and the model of each role, and any change on resume.
- **Idle threshold:** the `attemptIdleTimeoutMs` of the run, recorded when it starts and kept when it resumes. A run log without it, from an older version, counts as the default of 10 minutes.
- **Cost:** tokens per subtask and per run, per agent, attempts per subtask, wall clock with no pauses. The tokens of the independent verifier and of the acceptance tester count in the run and in their agent, and are kept apart from the attempts of the subtask.
- **Friction:**
  - blocks by type (scope, design question, patience, limit, environment, integration check);
  - automatic scope extensions;
  - rejections by the gate and by the verifier, and criteria failed by the acceptance tester whose command passed;
  - conflicts at integration (expected: 0).
- **Failures of the worker layer**, apart from the failures of the design:
  - the container does not start;
  - the end of the agent is not detected;
  - a process hangs;
  - commits or cleanup fail;
  - the token usage cannot be read.
- **Logs:** the path to the raw log of each attempt. An attempt enters `run.json` when it starts, as `running` with the path to its raw log, and gets its outcome when it ends, so the raw log can be read while it grows. For each check and criterion that failed, the end of its output, and the path to its whole output in `output/` of the run log.
- **Quality, after the merge:** changes I made at review, and escapes (bugs that the verification did not find). An escape is an issue with the label `escaped-defect` in the target repo, linked to the PR of the factory that brought it; it is counted with `gh issue list --label escaped-defect`, not by `factory stats`.

`factory stats` summarizes these files for a repo, per agent as well, to compare the subscriptions. It counts abandoned runs apart from the ones in progress and the finished ones, each with the threshold its own run log carries, so it does not read `.factory/config.ts`.

## Web view

`factory web [target-repo] [--port <port>]` serves the run log of a target repo as web pages, in the foreground, until Ctrl-C. The home page lists the runs from the most recent to the oldest, with issue, run ID, result, the age of the last change of its `run.json` and a link to the pull request. It lists apart the `run.json` files that cannot be read. A repo with no run log gets an empty page, not an error. The port has a fixed default, so the URL is always the same, and a busy port ends the command with exit code 1.

It is a view over files that already exist, and it keeps to these limits:

- **Read-only.** It starts, approves and changes nothing. `factory run` and `factory approve` stay in the terminal, where they are one line, and a server that could start them would hold push permissions on the host.
- **Only the run log.** It reads `.factory/logs/` of the target repo. It does not read the spec, and it uses neither git nor `gh`, so opening it touches nothing outside the run log and needs no credential.
- **No state of its own.** `run.json` stays the only source. The last change is the modification time of `run.json`. The web does not ask whether the process of a run is alive; it derives it from the files and `now`. The threshold of each run is the `attemptIdleTimeoutMs` that its `run.json` carries, so the web does not load `.factory/config.ts`; a `run.json` without it, from an older version, uses the default of 10 minutes. An attempt still `running` is **abandoned** when its raw log has not changed for longer than that threshold, because the worker layer stops any agent silent for that long. A run still `running` is abandoned when neither its `run.json` nor any of its raw logs has changed for that long. Example: `factory run` killed at 10:00 shows as abandoned from 10:11 with the default of 10 minutes. The page of a run links the raw log of an attempt in progress, which grows while it is read.
- **Only the folder of the run.** The page of a run links to the raw log of each attempt, of each independent verifier verdict and of the acceptance tester, and to the full output of each check or criterion that failed, as `text/plain`. The paths in `run.json` are not uniform: attempt and verifier paths are absolute inside the run folder, and check, criterion and tester paths are relative to it. A file is linked and served only when its real path, after the symlinks, lies inside the real path of `.factory/logs/<run-id>/` and it is a regular file. Anything else gets 404: `..`, an encoded traversal, an absolute path, a NUL byte, a directory, a symlink that points outside, a run ID that is not the format of a run ID or has no folder. A log can hold HTML, so the web sends it with `x-content-type-options: nosniff`.
- **Only `127.0.0.1`.** The run log can hold the output of the checks of a private repo. A `Host` header other than `127.0.0.1:<port>` or `localhost:<port>` gets 403, so that a web page in the browser cannot read the logs through DNS rebinding.

The server is `node:http`: no runtime dependency. The HTML is built on the server from the run log, with no JavaScript, and every text that comes from `run.json` is escaped. The request handler is a function of the method, the path, the `Host` header, the target repo, the port and `now`; it reads the real files but opens no socket.
