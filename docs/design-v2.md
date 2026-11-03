# Software factory: design, version 2

Status: agreed on 2026-11-03, not built. Version 1 is [`design.md`](design.md), and it stays as it is until the pilot in `askwell` closes. This document says only what version 2 adds or changes; what it does not mention works as in version 1. Nothing here holds before it is built. Specs: #105 (engagements), #106 (the `test` evidence type), #107 (the warning for an issue of another developer).

## Goal

Version 2 adds freelance work to the factory: new projects from zero for a client, delivered as a sequence of verified pull requests that I review and merge.

- Input of an engagement: the client's brief, in their words, with their attachments.
- Output of an engagement: the merged pull requests of its children, a protected preview of each one, a result note for each one that I send to the client, and a repo that I transfer at the end.
- Scope: one stack, from a versioned stack template. One engagement is run by one developer, on their own machine.
- No automatic merge, and no deploy to production. The coordinator deploys a protected preview of the verified SHA ([ADR 0011](adr/0011-preview-deployed-by-the-coordinator.md)).
- Nothing starts on its own, as in version 1.

What changes from the Goal of version 1: "new projects from zero" leaves the out of scope, and "no deploy" becomes "no deploy to production".

## What does not change

- Agents run only on subscriptions ([ADR 0001](adr/0001-subscriptions-only.md)); Codex stays out until its terms are checked.
- The coordinator stays deterministic. Every LLM call happens in a role: the refinement, the workers, the independent verifier, the acceptance tester or the new Plan reviewer.
- Only the coordinator, on the host, pushes, opens pull requests and deploys ([ADR 0005](adr/0005-publish-through-gh-over-https.md)).
- The web view binds `127.0.0.1` only and keeps its state in files ([ADR 0006](adr/0006-web-actions-through-the-cli.md), [ADR 0007](adr/0007-web-state-in-files.md)). Each new command is also a web action.
- Each child of an engagement is an issue with its own spec, refinement, approval and run, as in version 1.

Also new in version 2, apart from engagements: Slack notices next to the macOS notification, outgoing only (nothing reads Slack), and a skill that lets Claude Code drive `factory` for me.

## Engagements

An **engagement** is one job for one client. Its source is the **brief**; its scope, as the client reads it, is the **PRD**; its work is the **engagement plan**: a parent issue and its children, in order.

### Commands

| Command | What it does |
|---|---|
| `factory init --new <name>` | Creates a private repo in my GitHub from the current stack template and pushes it from the host |
| `factory refine-plan` | The plan refinement: writes the PRD, the parent issue and its children from the brief |
| `factory review-plan` | Runs the Plan reviewer on the brief, the PRD and the children, and records its findings |
| `factory approve-plan [--accept <finding> --reason <text>]…` | Checks coverage and the review, and approves the engagement plan with a hash |
| `factory note <n>` | Writes the result note of the last run of child `<n>` again, with no agent |
| `factory close-engagement` | Checks that every child is merged and every PRD section delivered, and writes the final note |
| `factory auth vercel` | Saves the preview token, once for every target repo |

The commands of version 1 stay. `factory run <n>` of a child gains the checks of [Children](#children). The first `factory refine-plan` creates the parent issue and records its number in `specs/engagement.md`; the commands of the plan read it from there.

### The engagement in the config

`.factory/config.ts` gains an optional `engagement` block. A target repo without it works exactly as in version 1.

- `client`: the client's name, recorded in each run.
- `developer`: the `gh` login of the developer who runs the engagement.
- `language`: the client's language, `es` or `en`. It chooses the template of the result notes.
- `tokenLimit`: the tokens of the whole engagement, per agent.
- `allowedAgents`: the agents that may see the code. A role whose agent is not in the list refuses to start (fail closed). An NDA decides it.
- `stackTemplate`: the version of the stack template that the repo started from. `init --new` writes it.

The config also gains an optional `preview` block, with the command that deploys and the command that tells its URL (see [Preview](#preview)).

### Stack template and `init --new`

See [ADR 0010](adr/0010-greenfield-from-a-versioned-stack-template.md).

- The stack template lives in this repo, with a version. Today there is one stack: Next.js on Vercel, with Neon.
- `factory init --new <name>` copies the current version, writes `.factory/` ready for it (checks, app start, evidence commands, protected paths, demo seed, preview) and the `engagement` block, creates a private repo with `gh` and pushes it from the host. No container takes part.
- It refuses a `language` with no template of result notes.
- The template never updates itself inside an engagement. A later version reaches a running engagement only as a change I make by hand.
- It ends with the steps left, as `factory init` does:

  ```
  Next:
    1. create the Neon project and fill .factory/.env
    2. create the Vercel project with deployment protection on
    3. factory auth vercel   save the preview token
    4. factory image
    5. write docs/brief.md   the client's request, in their words
    6. factory refine-plan
  ```

The Neon and Vercel projects stay manual until they repeat in three engagements.

### Brief and PRD

- **Brief:** `docs/brief.md`, in the client's words, with the attachments and mockups in `docs/brief/`. I write it and commit it. It is never approved by itself: it enters the hash of the engagement plan.
- **PRD:** `docs/prd.md`, in the client's language, with no technical terms. Each section starts with a heading whose first word is its ID: `## P3 Book an appointment`. A pure function parses it and reports a duplicate or missing ID. The PRD always exists, even half a page: it is the written scope that the client confirms outside the factory, and the source text of the result notes.

### Plan refinement

`factory refine-plan` is the Refinement role, with Claude Code on the host ([ADR 0003](adr/0003-interchangeable-agents.md)), and a skill of its own: the plan refinement. It runs in the terminal or turn by turn from the web, as `factory refine` does.

- It reads the brief and the stack template, and asks the open decisions in rounds, each with a recommended answer. I relay to the client only the product questions.
- It writes the PRD.
- It writes the parent issue, with the children as an ordered list, and each child issue: "What to build", criteria with IDs, `Part of #<parent>` and the PRD sections it delivers, `PRD: P1, P3`, or `PRD: none` for purely technical work.
- It writes no technical part of any child: each child gets its own refinement later, on the code of the children before it.
- The issues, criteria and code are in English. Only the brief, the PRD and the result notes are in the client's language.

### Plan reviewer

The **Plan reviewer** is a new role. `factory review-plan` runs it in a container of the worker image, created for one review and removed after it:

- with no bind mount: it receives in the prompt only the brief, the PRD and the list of children with their criteria;
- with every tool denied, checked as for the independent verifier, and fail closed when the denial does not load;
- with only the credential of its agent.

It returns a list of findings, each with an ID and what it refers to: "F2: the brief mentions cancellations and no child covers them". The coordinator records them in `specs/engagement.md` with a hash of what was reviewed. Its tokens count in the engagement.

An agent can serve as the Plan reviewer only if every tool can be denied to it with a fail-closed check, as for the independent verifier. Its agent and model are chosen like those of any role: `--plan-reviewer-agent`, the menu, or `roles.planReviewer` of the config.

### Approving the engagement plan

`factory approve-plan` writes in the header of `specs/engagement.md` the date, one hash and the findings I accepted with their reasons, and commits "Approve engagement plan #<parent>". The hash covers the ordered list of children, the criteria of each child, the brief and the PRD.

It refuses, and names what to fix, when:

- a child declares no PRD section and is not `PRD: none`;
- a PRD section is covered by no child;
- there is no review, or the reviewed hash no longer matches the plan;
- a finding is open and not accepted with `--accept <finding> --reason <text>`.

Coverage is a pure decision, checked by the coordinator, not by the Plan reviewer: the reviewer is for the gaps that code cannot check.

I approve the plan. The client confirms the PRD, outside the factory.

### Children

I start each child myself, with `factory refine <n>`, `factory approve <n>` and `factory run <n>`. `factory run` of a child adds these checks before any worker starts:

- **Plan hash.** It recomputes the hash of the engagement plan. If it differs, it stops and says what changed: the children, a criterion, the brief or the PRD (fail closed).
- **Order.** The previous child in the list must be merged into the default branch. Else it refuses and names it. There is no dependency graph and no stacked pull requests.
- **Engagement limit.** When the tokens of the engagement reach `tokenLimit`, a new child run refuses and the engagement is blocked with its reason. A run in progress ends within its own limits.
- **Developer.** When my `gh` login is not the engagement's `developer`, it warns in yellow, records the warning in `run.json` and goes on: "acme-reservas belongs to ana. Your runs do not count in her consumption, nor hers in yours. The token limit does not hold between you." Who runs an engagement is how I organize, not a safeguard. Every other refusal of this document fails closed.

The consumption of an engagement comes from the run logs of its runs and its plan reviews on this machine. Each `run.json` of a child records the engagement and the client.

### Preview

See [ADR 0011](adr/0011-preview-deployed-by-the-coordinator.md).

The preview is a step of the publication, after the integrated verification and before the PR is opened or updated:

- The coordinator, on the host, exports the verified SHA with no `.git` and runs the `preview` command of the config on it, with the preview token. The build happens on Vercel, never on the host, because the host holds the `gh` session and the code was written by agents.
- No container receives the preview token. It is not a credential of an agent, and it is never written under `.factory/web/`.
- The preview is protected, has its own environment and its own Neon branch, and loads the demo seed during its build on Vercel.
- `run.json` records the URL, the deployed SHA and the result. The PR, the result note and the web link it.
- A commit after the verified SHA needs a new deploy.
- A failed deploy is a failed publication: `factory publish <n>` repeats it with no agent.
- The preview is never evidence and never blocks the "ready" of the PR.

Readiness: `factory run`, `factory publish` and `factory doctor` check the preview token when the config has a `preview` block, and fail closed without it.

### Demo seed

- The stack template brings a **demo seed**: believable data in the client's language, such as "Marta's hair salon, 10:30, haircut", never "test user A1".
- It is a protected path: only the base subtask of a child extends it.
- It loads in the app of the acceptance tester and in the preview. The checks and the request checks keep their own data.

### Human criteria and mockups

- A human criterion may name a mockup of `docs/brief/`: "A4 looks like `docs/brief/agenda.png`". The PR shows the mockup next to the screenshot of the criterion from the evidence branch.
- I validate the human criteria first. Then I record in the PR which ones the client approved on the preview.
- I merge after my review. The client's feedback enters as a new child or as a change of a pending child, never as a wait.

### Result notes

See [ADR 0012](adr/0012-the-client-sees-no-implementation.md).

At the publication of a child, the coordinator writes a **result note** in `.factory/logs/<run-id>/note/`, outside git:

- the text of the PRD sections of the child;
- the link to the preview;
- the screenshots of the acceptance tester for the criteria of those sections, copied next to the note;
- the fixed texts ("What's new", "Try it here") from the template of the client's language.

It holds no criteria IDs, issues, PRs, branches or technical terms. A pure function builds it, so it needs no LLM. A child with `PRD: none` gets no note. `factory note <n>` writes it again from the run log. The factory never sends it: I do.

### Changes during an engagement

- A change of the brief or the PRD breaks the hash of the engagement plan, so the next child run refuses.
- `factory refine-plan` again changes only the children that have not started. A child that started or merged stays as it is.
- Then the plan is reviewed and approved again.

### Closing

`factory close-engagement` refuses, and names the cause, while a child is not merged or a PRD section has no merged child: "P5 is missing: child #5 is not merged". When everything is delivered, it writes a final note with every PRD section and the link to the last preview. I transfer the repo by hand.

### Board

The board groups the children under their engagement, in order: the parent, the child ready to start, and the PRD sections already delivered. "acme-reservas: 2 of 4 children merged. P1 and P3 delivered." It is read-only and comes from `gh issue list`, `specs/engagement.md` and the run log.

### What the client sees

The client never uses the factory. They see the brief, the PRD, the mockups, the previews and the result notes. They never see the engagement plan, the issues, the specs, the PRs, the criteria, the evidence or the board. At the delivery they receive the repo, and with it the code.

## The `test` evidence type

See [ADR 0013](adr/0013-test-evidence-with-no-running-app.md). It applies to any target repo, not only to engagements.

- A criterion may have `test` evidence: a command of the config with `{{id}}`, which runs a test that the worker writes. For example, a test that loads `openapi.yaml` and checks that `POST /bookings` returns a `Booking`, or one that checks that paying publishes `payment.completed`.
- The refinement chooses `test` only when the running app cannot prove the criterion: there is no app, or the behaviour is asynchronous.
- At the gate, the independent verifier judges the test as it judges a Playwright test.
- A failed `test` criterion in the integrated verification sends a follow-up task, as any criterion does.
- The acceptance tester runs only when a criterion has Playwright or request evidence, and it never receives a `test` criterion. The same rule decides when `factory run` needs its credential.
- When the tester does not run for this reason, the PR says so in one line: "No acceptance tester: no criterion needs a running app."

## Two developers on one target repo

Each developer has their own installation, credentials and `gh` session, with no shared state. The rule of one run at a time per issue reads only the local run log, so before a run starts `factory run` reads two facts with `gh`, with no git fetch:

- the assignees of the issue;
- the remote branches `factory/<n>-*` that no run of my local run log published.

When either points to someone else, it warns in yellow and goes on: "#28 is assigned to luis, and origin already has factory/28-add-booking". When `gh` cannot read them, it warns that they could not be checked. The warning goes to `run.json`. The local rule keeps refusing as in version 1.

## Other kinds of target repo

### Monorepos

A monorepo is one target repo, with one config, one worker image and one app start. Nothing in the design changes:

- The shared contracts, such as a contracts package, are protected paths, so only the base subtask changes them.
- The app start starts every service as a process in one container, and the ready command checks each one. No container gets Docker, so a service that needs a broker or a database outside the image stays out, or uses one in memory.
- The checks run on the whole repo. Checks of only the affected services wait for the measured duration of the gates.
- A change across two repos is two issues, in order, that I start one after the other.

### Repos of contracts

A repo of OpenAPI and AsyncAPI documents edited by hand is a target repo with a `package.json`, whose checks are the linters of the contracts and whose criteria use the `test` evidence type. A repo whose contracts are generated from the code of the services, such as a mirror of each service's documentation, is never a target repo: the change goes to the service.

## Pending for version 3

- **Scheduled maintenance:** work of code that starts on a schedule and ends in a verified PR, such as updating the dependencies of a delivered repo every Monday. It changes "nothing starts on its own" and needs its own ADR, a scheduler on the host, access to the client's repo after the transfer, and limits per repo.

## Out of version 2

- A client portal, or any access of the client to the factory.
- Requests from Slack, work that is not code, and answers that start on their own.
- Designs generated by the factory, and sending anything to the client.
- The loop of the client's review observations, and `factory leads`.
- A dependency graph between children, stacked pull requests, and two developers on one engagement.
- More than one stack, and templates of result notes beyond `es` and `en`.
- Holdout scenarios of type `test`, and evidence for mobile apps: their criteria stay human.

## Parked

Not decided, and not needed to build version 2:

- whether client work is commercial use of the subscriptions;
- the default allowed agents of an engagement;
- whether `.factory/` stays in the repo at the delivery;
- whether the contract with the client declares the agents.
