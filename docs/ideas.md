# Ideas, not decided

Raised on 2026-11-06, when version 2 (freelance engagements) was withdrawn. They wait until the web view drives the whole loop of [`design.md`](design.md). None of them is a decision, and none adds a term to the glossary yet.

- **Freelance work.** A job for a client, from what the client asks for to the delivery of a repo, designed again from zero.
- **A proposal phase** before the scope of a job is fixed. Roles that do no code, such as a researcher, a brainstorming role, a content writer, a UX role and a content designer, produce the material from which the scope comes.
- **A lead role.** A conversation in the web with an agent that delegates to other roles. It asks for each delegation as data, and the coordinator validates it and starts that role in its own container, with the agent and model chosen for it, so the coordinator stays deterministic and each role keeps its own agent ([ADR 0003](adr/0003-interchangeable-agents.md)).
- **Conversations grouped by target repo**, and groups that belong to no target repo, such as brainstorming.
- **Files and pages.** Files are the files that enter or are produced in a target repo or a group, in folders. Pages are HTML documents that a role writes and the web shows in an isolated `iframe` (`sandbox` with no `allow-same-origin`), so that a script of a page cannot send a form to the server with its token.
- **The client stays out of the factory**: I am the only one who talks to them. A client portal or a web beyond `127.0.0.1` needs its own ADR.

