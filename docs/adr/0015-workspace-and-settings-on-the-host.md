# One web for every repo of a workspace, and settings on the host that hold the default models

The developer wants to drive every target repo from one web view, add a repo from GitHub there, and change the default agent and model of each role in one place. Until now `factory web` served one target repo, its Settings were read only, and each repo chose its roles in its own `.factory/config.ts`.

Now a **workspace**, one folder of the host, holds the target repos, and `factory web` serves every git repo with a GitHub `origin` directly inside it. The list is the folder itself, with no registry. A repo is added with `factory clone`, a web action that clones with the `gh` session of the host. The **settings**, one file next to the credentials on the host, hold the workspace, the default agent and model of each role, and the integrations, for every repo. They change only through `factory settings set`, a web action like any other, so the server still writes nothing itself ([ADR 0006](0006-web-actions-through-the-cli.md)). The roles leave `.factory/config.ts`.

The web still binds `127.0.0.1`, serves one developer and keeps its state in files ([ADR 0007](0007-web-state-in-files.md)), so neither of those decisions opens again.

## Considered Options

- **A list of registered repos in a file of the host.** Rejected: it is a second source that can disagree with the disk, and it needs commands to add and remove entries. The folder already says which repos exist.
- **Any folder of the disk, not only inside the workspace.** Rejected: the web would need the registry above, and a run of a repo the developer forgot would still show. Moving a repo into the workspace is a one-time step.
- **One `factory web` per repo, on different ports.** Rejected: Live could not show every agent at work in one page, and each server would need its own token.
- **The web edits the roles in `.factory/config.ts`.** Rejected: the file is TypeScript, hard to rewrite safely, and each change would leave a change without a commit in the target repo.
- **`.factory/config.ts` may still set the roles and win over the settings.** Rejected for now: the developer wants one place to change them. A run that needs another model chooses it in its form. An override per repo may come later, with its own decision.

## Consequences

- `factory web` takes no target repo, and every page except Live and Settings belongs to one repo, whose folder starts its URL.
- A `.factory/config.ts` that still has `roles` fails to load, and says to move them to the settings. The origin `config.ts` of the menu of a run becomes `settings`.
- The settings file holds secrets of integrations, such as the webhook of Slack, so it has mode `0600`, is never written under `.factory/web/` and never enters a container.
- Integrations are a list that can grow. Slack is the first, with outgoing notices only, so the rule that nothing starts on its own holds.
