# A new project starts from a versioned stack template that the factory owns

Version 1 takes only existing repos: their checks, app start and evidence commands already exist, and `factory init` only adds `.factory/`. Freelance work is new projects from zero, so there is no repo to start from. `factory init --new` creates a private repo in my GitHub from the current version of a stack template that lives in this repo, writes `.factory/` ready for it, records the version in the engagement and pushes it from the host. There is one stack. The template never updates itself inside an engagement: a later version reaches a running engagement only as a change I make by hand.

The template carries what a run needs to verify anything from the first child: the checks, the app start and its ready command, the Playwright and request commands, the protected paths, a demo seed and the preview. A stack that has never been through a run has none of that proven.

## Considered Options

- **Any stack, chosen per job.** Rejected: each stack needs its own checks, app start, evidence commands, worker image and preview, and none would be proven before a client depends on it. One stack until the template has delivered two engagements.
- **Let an agent scaffold the project in the first child.** Rejected: the base of every later child would be code that no template fixed, and the first run would have no checks or evidence commands to verify itself with.
- **A template repo on GitHub, apart from the factory.** Rejected: `init --new`, the config it writes and the template change together, so they are versioned together.
- **Update the template in running engagements.** Rejected: a change of the base in the middle of a job can break children already merged, and the client's scope does not change because the template did.

## Consequences

- The goal of version 1 changes: new projects from zero leave the out of scope.
- `init --new` is the second place, after `factory init`, that knows a package manager and a stack.
- The Neon and Vercel projects of an engagement stay manual steps of `init --new` until they repeat in three engagements.
- A fix to the template does not reach the engagements that already started it.
