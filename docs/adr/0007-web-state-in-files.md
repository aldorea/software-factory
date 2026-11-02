# The web view keeps its state in files, with no database

The web view has state of its own now: the web actions it started, their output, their end and the turns of a refinement. That state lives in files under `.factory/web/<id>/` of the target repo, outside git, next to the run log under `.factory/logs/`. The run log stays the only source of a run; the files of a web action describe only the web action.

Each file has one writer. The server writes `action.json` when it starts a web action: the command, the issue, the start time, and the process group with its start time. The CLI, started with `--web-action <id>`, writes its exit code and end time, so a web action that ends while the server is down still records its end. Each turn of a refinement is a file of its own. A writer writes a temporary file and renames it, so a reader never sees half a file. The server rebuilds its view from these files when it starts, and derives what no file states: a web action whose process is gone, or whose process start time differs, and that has no end is interrupted.

The rules that need state across processes read the files that exist. A second run of the same issue is refused from its run log, and a second turn of the same refinement from the web actions in progress, so the terminal and the web check the same thing with no lock.

## Considered Options

- **PostgreSQL, as hosted factories with many users do.** Rejected: one developer, on `127.0.0.1`, with tens or hundreds of web actions needs no queries across many writers. It adds a server to install, migrate and back up, a runtime dependency (the `pg` driver), and tests that need a real database and Docker, while every decision that fails closed must have a test with no Docker. The state of a run would exist twice, in the run log and in the database, and the two could disagree.
- **SQLite through `node:sqlite`.** Rejected for now: it adds no dependency and no server, but it is still a second store of state next to the run log, and its rows cannot be read with `cat` or `grep` by the developer or an agent.
- **No state of its own: keep the web actions only in the memory of the server.** Rejected: a restart of `factory web` would lose the output, the end and the Stop button of a web action that is still running, and the conversation of a refinement.

## Consequences

- The design rule that the web view has no state of its own changes: `.factory/web/` is the source of the web actions, as the run log is the source of the runs.
- Queries across runs, such as the filters of the home page or the board, read the files at each request. That holds at the volume of one developer.
- Nothing removes old web actions; the folder grows with the history of the target repo.
- The history of web actions shows only what the web started. A command started in a terminal writes nothing under `.factory/web/` and shows only through its run log.
- A token or a credential is never written under `.factory/web/`.
- If the web view ever serves several users, listens beyond `127.0.0.1` or receives webhooks, this decision is open again.
