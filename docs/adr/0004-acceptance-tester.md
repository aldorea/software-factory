# A black-box acceptance tester runs in the integrated verification

The evidence of a criterion was a test that the worker of the same subtask wrote, read by an independent verifier that sees only the criterion and the test. Nothing used the app the way a user would without knowing the code, so a test that passes while the behaviour is wrong (a wrong selector, a mocked path, a state the test never reaches) reached the pull request. We add a role, the acceptance tester: an agent with its own clean context that receives only the text of the criteria and the running app, uses the app as a user would, and leaves a file of evidence per criterion. It runs once per round of the integrated verification, only when the checks and the automatic criteria already pass, and it tests every Playwright and request criterion of the run, never a human one. A criterion it fails counts as a failed criterion: it sends a follow-up task with the observation and its file to the subtask that owns it, under the same patience and limits.

The idea comes from a factory that splits its review into a black-box app check and a white-box code review, after an audit found that a single agent reviewer had sent back 0 of 37 pull requests and that 5 of 12 escaped defects had been seen before the merge and graded as passing.

## Considered Options

- **Keep the independent verifier alone.** Rejected: it judges whether a test proves a criterion, but it cannot see what the app does, and the test comes from the worker it checks.
- **An agent that reviews the diff for bugs and regressions.** Rejected for now: the developer reviews every pull request and the gate covers the mechanical checks of the diff. It is reconsidered when the escaped defects show bugs that a reading of the code would have found.
- **The tester at every gate.** Rejected: it multiplies the cost by the attempts of every subtask, while the evidence of the pull request comes only from the integrated verification.
- **Holdout scenarios hidden from the workers.** Deferred: the containers already keep a file on the host out of the workers' reach, with any agent, but nobody writes or maintains the scenarios yet. It is reconsidered when the escaped defects show behaviour that the criteria do not describe.

## Consequences

- The tester is a role like the others: the developer chooses its agent and model before a run, and the pull request says so when it uses the model of the workers ([ADR 0003](0003-interchangeable-agents.md)).
- Unlike the independent verifier, it needs tools and the code to start the app. That it never reads the diff or the tests rests on its prompt, not on the container.
