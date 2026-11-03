# The client sees no implementation, and the result notes come from the PRD with no LLM

The client of an engagement never uses the factory, and I am the only one who talks to them. During the engagement they see the brief, the PRD, the mockups, the previews and the result notes. They never see the engagement plan, the issues, the specs, the pull requests, the criteria, the evidence or the board. At the delivery they receive the repo.

So the factory needs text that a client can read for each child, and the coordinator makes no LLM call. The PRD gives that text: it is in the client's language, each section has a fixed ID, and each child declares the sections it delivers. At the publication, a pure function builds the result note from those sections, the preview link, the acceptance tester's screenshots and a template of fixed texts in the client's language. I send it.

## Considered Options

- **A client portal, where the client writes the brief, reads the plan and approves.** Rejected: it needs several users and a web view beyond `127.0.0.1`, which opens again [ADR 0006](0006-web-actions-through-the-cli.md) and [ADR 0007](0007-web-state-in-files.md).
- **The client reads the pull requests on GitHub.** Rejected: they would need a GitHub account and would read criteria, branches and evidence that describe the implementation.
- **An agent writes each note.** Rejected: it adds a role and a cost per child, and a summary could promise what the verification did not prove. The PRD already holds the text the client confirmed.
- **The criteria in the client's language, for the client to validate.** Rejected: the client never reads them, and the repo keeps one working language.
- **The client accepts the engagement plan.** Rejected: the plan is implementation. I approve it; the client confirms the PRD, outside the factory.

## Consequences

- The PRD is required, even half a page, and each section has an ID.
- `approve-plan` checks in both directions that every PRD section has a child and every child has a section or `PRD: none`, and `close-engagement` checks that every section was delivered.
- The notes have a template per language. Only `es` and `en` exist, and `init --new` refuses another language.
- The factory never sends anything to the client.
- At the delivery the client receives the code, so the rule holds during the engagement, not after it.
