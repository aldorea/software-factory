# The web view is a React client over a read-only JSON API

The web view was HTML built on the server with no JavaScript, and a page with something in progress reloaded itself. The developer wants a professional console and a Live page that shows every agent at work, refreshed every 2 seconds, with a detail that opens beside the cards. A full reload every few seconds flickers and loses the scroll, and hand-written HTML and CSS do not reach the look of a console. So the web view becomes a React client, built with Vite before `factory web` starts, served by the same `node:http` server next to a read-only JSON API.

The server keeps every rule of the web view: no runtime dependency in Node, `127.0.0.1` only, the `Host` check, the `Origin` and the token on a `POST`, the web actions through the CLI ([ADR 0006](0006-web-actions-through-the-cli.md)) and the state in files ([ADR 0007](0007-web-state-in-files.md)). The decisions stay in pure functions of the server that return data, tested with no browser; the client only draws them. React, React Router in declarative mode, Tailwind and the components of shadcn/ui on Radix are dependencies of the build, bundled into the client, never loaded by Node.

The prototype is the branch `prototype/web-react-live`, variant D.

## Considered Options

- **Keep the HTML of the server and add a small script that swaps a fragment every 2 seconds.** Rejected: lighter, but the console the developer wants (a detail pane, tabs and an agent in the URL, a theme toggle, components with a consistent look) would be a framework written by hand.
- **React rendered on the server with `renderToString`.** Rejected: React becomes a runtime dependency of Node, JSX still needs a build, and the page still reloads to update.
- **Server-Sent Events instead of asking every 2 seconds.** Rejected: the server would watch files and keep sockets open, and the handler would stop being a function of the request and `now`. A delay of 2 seconds is live enough for one developer.
- **SQLite to hold the state of runs or the live activity.** Rejected again for the reasons of ADR 0007: the activity is already in the raw logs, and reading the end of a few files every 2 seconds costs nothing at the volume of one developer.
- **A free canvas with cards to drag, as some dashboards of agent swarms do.** Rejected: it is the heavy part, and it adds nothing for one developer.

## Consequences

- The factory has a build step for the first time. `pnpm install` builds the client into `dist/web/` with a hash of its sources, and `factory web` fails closed when the build is missing or stale.
- The page needs JavaScript. There is no page without it.
- Every path that is not the API or a file of a run returns the page of the client, so the URLs of today, including the link of a notification, keep working.
- The tests of the views move to the JSON the server returns; the client gets its own tests with `jsdom` and Testing Library, with no mocks of processes, git or the file system.
- If a run log grows enough that reading files every 2 seconds is slow, a cache rebuilt from the files may come, never a second source of state.
