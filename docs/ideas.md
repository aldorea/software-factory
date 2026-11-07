# Ideas, not decided

Raised on 2026-11-06, when version 2 (freelance engagements) was withdrawn. They wait until the web view drives the whole loop of [`design.md`](design.md). None of them is a decision, and none adds a term to the glossary yet.

- **Freelance work.** A job for a client, from what the client asks for to the delivery of a repo, designed again from zero.
- **A proposal phase** before the scope of a job is fixed. Roles that do no code, such as a researcher, a brainstorming role, a content writer, a UX role and a content designer, produce the material from which the scope comes.
- **A lead role.** A conversation in the web with an agent that delegates to other roles. It asks for each delegation as data, and the coordinator validates it and starts that role in its own container, with the agent and model chosen for it, so the coordinator stays deterministic and each role keeps its own agent ([ADR 0003](adr/0003-interchangeable-agents.md)).
- **Conversations grouped by target repo**, and groups that belong to no target repo, such as brainstorming.
- **Files and pages.** Files are the files that enter or are produced in a target repo or a group, in folders. Pages are HTML documents that a role writes and the web shows in an isolated `iframe` (`sandbox` with no `allow-same-origin`), so that a script of a page cannot send a form to the server with its token.
- **The client stays out of the factory**: I am the only one who talks to them. A client portal or a web beyond `127.0.0.1` needs its own ADR.
- **Models per target repo.** A target repo that overrides the default models of the settings. Today the settings hold them for every repo, and a run changes them only for itself ([ADR 0015](adr/0015-workspace-and-settings-on-the-host.md)).
- **More integrations** after Slack, in the Integrations section of the settings.
- **Edit the skills and prompts of the factory from the web.** Each save is a commit in the repo of the factory, so each change is a new version that the runs record. Until then the web only shows them.
- **The AI writes the script once, and then the script runs.** Where a script can do the work, no agent acts on each run: an agent writes the script, I review it, it is versioned in git, and from then on every run executes the script. Today this already holds for the evidence tests, the holdout scenarios and the coordinator. Two places to apply it:
  - `factory init` starts an agent that reads the target repo and proposes the commands of the gates in `.factory/config.ts` (checks, app start, Playwright, holdout); I review and approve them in the web, and every run executes them with no AI;
  - a library of scripts of my own ("load test data", "regenerate the API types"), written by an agent, reviewed and versioned, and started from the web as a command.
- **Compare two runs**: what changed between them, in prompts, skill, models or commands, from the versions that each `run.json` records.
