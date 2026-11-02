# The web view starts the commands of the CLI, never the coordinator itself

The developer can do from the web view what they do with the CLI, actions included: start a run, approve a spec, publish again, set a credential. Until now the web view was read-only, because a server that could start a run would hold the push permissions of the host.

A web action runs the same `factory` command, with an array of arguments and no terminal, in a process group of its own. The server never calls the coordinator, git, `gh` or an agent. So every rule of the CLI holds unchanged: the readiness checks, the refusals, the hard rule that only the coordinator pushes and opens pull requests ([ADR 0005](0005-publish-through-gh-over-https.md)), and the rule that nothing starts on its own. A run outlives the server, so stopping `factory web` does not lose work.

The server binds `127.0.0.1` only and accepts a `POST` only with the `Origin` of its own URL and a random token created when it starts, because any page open in the browser can send a form to `127.0.0.1` and such a request passes the check of the `Host` header.

## Considered Options

- **Keep the web read-only and show each command to copy.** Rejected: the developer wants one place to follow and act on the factory; copying a command to a terminal is the step the web should remove.
- **Call the coordinator in the process of the server.** Rejected: the server would hold the `gh` session and the push, a crash of the server would kill the run, and the rules that the CLI checks would need a second copy.
- **Emulate a terminal in the page to run `factory refine` and the menus.** Rejected: it needs a native runtime dependency (a pseudo-terminal) and a script in the page. The menus become forms that send the same flags, and the refinement opens a Terminal window.
- **Only the `Host` check, as for the read-only pages.** Rejected: it stops DNS rebinding but not a form that another page sends to `127.0.0.1`.

## Consequences

- The design of the web view changes: it is no longer read-only, and it shows the live activity of an attempt, as the CLI does.
- The output of each web action is a new file under `.factory/web/` of the target repo, outside git.
- A run started in a terminal is stopped in its terminal; the web stops only what it started.
- A credential travels from the browser to the server in the body of a `POST` on `127.0.0.1`, and from the server to `factory auth` on its standard input.
