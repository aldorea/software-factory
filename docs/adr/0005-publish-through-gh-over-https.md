# Publish through the gh session over HTTPS, from the host only

Only the coordinator, on the host, pushes and opens pull requests: a worker commits in its worktree and the coordinator collects its commits, merges them and publishes the run. No container holds a GitHub credential. An agent with tools and a credential could push to any branch or repo, open or close pull requests, or carry the credential out; without one, the worst it can do is break its own worktree, and the gate decides what enters.

The coordinator pushes over HTTPS with the `gh` session as the only credential helper, and with terminal prompts disabled, whatever the remote of the target repo says. `gh` is already required and signed in to open the pull request, so the push needs nothing else: a run no longer depends on SSH keys or on port 22 being open, and a missing credential fails at once instead of waiting for input. A failed publication is recorded and can be repeated with `factory publish <n>`, so the work of a run is not lost to the network.

## Considered Options

- **Push from the container of each worker.** Rejected: every container would need a GitHub credential, which the agent could use or leak.
- **Push with the git configuration of the host, as before.** Rejected: the push then depends on SSH keys, `~/.ssh/config` and the network allowing port 22, none of which the factory checks, and a failure lost the publication of a finished run.
- **An option per target repo, such as `push: "ssh" | "https"` in `.factory/config.ts`.** Rejected: the transport depends on the developer's machine and network, not on the repo, and it would be one more step of setup in every repo.

## Consequences

- The token of `gh` needs the `workflow` scope to push a branch that changes `.github/workflows/`; without it the push fails with GitHub's message, and the fix is `gh auth refresh -s workflow`.
- The developer's own remote and `gh` protocol stay as they are; only the factory's pushes use HTTPS.
