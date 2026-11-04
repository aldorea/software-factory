# Holdout scenarios run after the acceptance tester, and no agent of the run sees them

The workers write the tests of their criteria, the independent verifier reads those tests, and the acceptance tester starts from the text of the criteria. All three start from what the workers know, so a worker can satisfy the letter of a criterion while the product does what nobody wanted. The acceptance tester keeps away from the tests of the workers only because its prompt says so. [ADR 0004](0004-acceptance-tester.md) deferred holdout scenarios until the escaped defects showed behaviour that the criteria do not describe. We adopt them now, before that data exists, after a review by a colleague whose own factory runs tests that the agents cannot see, because agents learned to pass the tests they could read.

A holdout scenario is a Playwright test or a request check that the refinement proposes and the developer accepts. It lives in `.factory/holdout/<n>/` of the target repo, on the host, ignored by git, and the approval freezes it with a third hash. It runs once per round of the integrated verification, after the checks, the criteria and the acceptance tester pass, in a container with no agent. A failed scenario sends no follow-up task: the run ends with a draft PR and a `holdout` block, and the developer decides.

## Considered Options

- **Keep them deferred until the escaped defects show the need.** Rejected by the developer: the factory measures escaped defects only after merges, and the data would come late.
- **The developer writes every scenario by hand.** Rejected: this is the cost that made ADR 0004 defer them. The refinement proposes them and the developer reviews each one.
- **A new role that writes the scenarios, with its own agent and model.** Rejected for now: it adds an adapter capability, a flag and a config entry for little more independence. The workers never share a context with the refinement anyway.
- **Store them in git: on the integration branch, or on a branch with no common history, like the evidence branch.** Rejected: a container mounts the git directory, so it can read every object of the repo.
- **Send a failed scenario back to the worker as a follow-up task.** Rejected: the worker would learn the scenario and pass it in the next round, and a scenario can cross several criteria with no subtask that owns it.
- **Run them before the acceptance tester, or at every gate.** Rejected: their failure ends the run, so they run last, once the rest already passes.

## Consequences

- `factory doctor` and `factory run` fail closed when git does not ignore `.factory/holdout/`.
- The container of the scenarios gets a copy of the integration branch exported with no `.git`, because the app it starts comes from the workers and must not be able to write the scenarios where a later worker could read them.
- The PR gives only how many scenarios passed and how many failed. Their names, content, output and evidence stay in the run log, outside git, and the evidence branch never holds them.
- The scenarios are not versioned. Losing the folder loses them, and a changed folder needs a new approval.
- A scenario that the developer turns into a criterion is no longer hidden, so it leaves the folder.
- A failed scenario counts in the measurement apart, when every criterion and the acceptance tester passed: it is the closest signal to an escaped defect that the factory sees before the merge.
