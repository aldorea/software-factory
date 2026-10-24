# Software factory

A personal factory that turns a GitHub issue of a TypeScript repo into a verified pull request for human review.

## Language

### Input

**Target repo**:
The repo that an issue belongs to and that the factory changes. It holds the factory's per-repo configuration.
_Avoid_: client repo, project

**Criterion**:
One acceptance criterion of the issue, with an ID `A1`, `A2`… The developer decides the criteria.
_Avoid_: requirement, AC

**Spec**:
The issue ("What to build" and the criteria) together with its technical part in `specs/<n>.md`.
_Avoid_: plan, ticket

**Refinement**:
The interactive session that turns an issue into a spec and asks the developer only the open decisions.

**Approval**:
The act that freezes a spec by recording a hash of each of its two parts. A run starts only from an approved spec whose hashes still match.

### Run

**Run**:
One execution of the factory for one issue, from the approved spec to the pull request.

**Coordinator**:
The deterministic program that drives a run: it schedules subtasks, applies the gates and the stop rules, and opens the pull request.
_Avoid_: orchestrator

**Agent**:
A CLI that runs on a subscription and does the work of a role: today Claude Code or OpenCode Go.

**Role**:
What an agent acts as in the factory: the refinement, the workers of a run, or the independent verifier. The developer chooses the agent and the model of each role before a command starts.
_Avoid_: stage

**Worker**:
An agent that implements one subtask in its own container, on its own branch.
_Avoid_: agent (too broad), runner

**Worker layer**:
The part of the factory that starts, supervises and stops workers and the independent verifier on behalf of the coordinator.

**Attempt**:
One invocation of the agent inside a worker, from its start to its report or its stop.

**Subtask**:
A group of criteria with its scope paths, implemented by one worker.
_Avoid_: task, job

**Base subtask**:
The subtask that holds what every criterion shares. It runs first and alone, and only it may change protected paths.

**Wave**:
A set of subtasks with disjoint scope paths that run in parallel.

**Scope paths**:
The paths that a subtask may change.

**Protected paths**:
The paths that only the base subtask may change: schema, lockfile, package manifests and shared registration files.

**Scope extension**:
A path the coordinator adds to a subtask's scope during a run, recorded in the run log and the pull request, never in the spec.

**Integration branch**:
The branch of a run, `factory/<n>-<slug>`, where each accepted subtask merges and from which the pull request is opened.

**Follow-up task**:
Work sent back to the subtask that owns a criterion that failed the integrated verification.

**Evidence branch**:
The branch `factory-evidence/<n>`, with no common history with `main` and never merged, where the coordinator publishes the attachments of the human criteria so that the pull request can link them.

**Run log**:
The record of a run in `.factory/logs/<run-id>/`, outside git: `run.json` and the raw log of each attempt.

### Verification

**Checks**:
The target repo's own commands (type checking, linting, tests) that every change must pass.

**Evidence**:
The proof that a criterion passes: a Playwright test, a request with its expected response, or a human review.

**Request check**:
The request and its expected response that prove a criterion. The base subtask writes it, because it fixes the contracts, and workers cannot change it. It is evidence, not one of the checks.

**Human criterion**:
A criterion whose evidence is the developer's review, allowed only for a visual or subjective criterion, with the reason in the spec.

**Gate**:
The coordinator's own verification of a subtask on its branch before it merges, independent of what the worker reports.

**Independent verifier**:
An agent with its own clean context that receives only a criterion and its test, judges whether the test proves the criterion, and tries to refute it. It never shares a context with the workers, even when it runs the same agent and model.
_Avoid_: reviewer, judge

**Integrated verification**:
The checks and all the criteria run on the integration branch. It is the only source of the evidence in the pull request.
_Avoid_: final check

**Fail closed**:
To stop when a safeguard cannot be confirmed, instead of going on without it: a run stops when a hash of the approved spec no longer matches, and fails when the independent verifier's config does not load.

### Stop

**Patience**:
The stop rule for a subtask that makes no progress: a number of attempts in a row with the same error signature.

**Error signature**:
What identifies a failure across attempts: the same check, the same test or the same first error line.

**Hard limit**:
A cap on wall clock or tokens, per subtask or per run, that stops a loop that progresses too slowly or costs too much.

**Blocked**:
The state of a subtask that stopped, with its reason and its last failure. The subtasks that do not depend on it go on.
_Avoid_: failed

**Plan limit**:
The usage cap of the subscription of one of the agents of a run, per window of that subscription. Reaching it pauses the run.

**Paused**:
The state of a run that reached the plan limit of one of its agents. It is not a failure: no worker starts and no patience or wall clock is spent until the developer resumes it.
_Avoid_: blocked, failed
