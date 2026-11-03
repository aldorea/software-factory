# The coordinator deploys a protected preview of the verified SHA, from the host, with the build on Vercel

A client cannot read a pull request, and they should not try a branch on their own machine. Version 1 does no deploy. In version 2, the publication of a child also deploys a preview: the coordinator, on the host, exports the verified SHA with no `.git` and runs the preview command of the config with the preview token. The build happens on Vercel. The preview is protected, has its own environment and database, and loads the demo seed. It is never evidence and never blocks the "ready" of the pull request. A failed deploy is a failed publication, repeated with `factory publish <n>`.

This extends [ADR 0005](0005-publish-through-gh-over-https.md): what leaves the machine leaves from the host, by the coordinator, and no container holds the secret that sends it.

## Considered Options

- **Deploy from a container.** Rejected: the container would need the preview token, which its agent could use or carry out, as ADR 0005 rejects for the `gh` session.
- **Build on the host and upload the result, as `vercel deploy --prebuilt` does.** Rejected: the build runs code that agents wrote, on the machine where the `gh` session lives.
- **Run the acceptance tester against the preview, so that it becomes evidence.** Rejected: the evidence would depend on an external network and service, and [ADR 0004](0004-acceptance-tester.md) keeps the tester on the app in its own container.
- **A public URL.** Rejected: it exposes the client's app before the client wants it, and an NDA may forbid it.
- **Pages that an agent publishes when it wants, as some factories do.** Rejected: a deploy is a command with an exit code that the coordinator runs; no agent decides what is published or when.

## Consequences

- The goal of version 1 changes: no deploy becomes no deploy to production.
- A new kind of secret exists, the preview token. It is not a credential of an agent, never enters a container and is never written under `.factory/web/`. Readiness of `run`, `publish` and `doctor` checks it when the config has a preview.
- A preview may cost money on Vercel, even though it is not an LLM.
- A commit after the verified SHA needs a new deploy, as it needs new evidence.
