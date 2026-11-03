# A test criterion proves what no running app can show, with the independent verifier alone

Playwright and request evidence need a running app, and so does the acceptance tester. Some target repos have none: a repo of contracts, or a service that cannot start without a broker or a database that the worker image does not hold. Some behaviour cannot be seen through the app either, such as an event that a service publishes. Their only evidence was my review.

We add the `test` evidence type: a command of the config with `{{id}}`, which runs a test that the worker writes. At the gate, the independent verifier judges whether the test proves the criterion and tries to refute it, as for Playwright. The acceptance tester runs only when a criterion has Playwright or request evidence, and never receives a `test` criterion. The refinement chooses `test` only when the running app cannot prove the criterion.

For these criteria this is the option that [ADR 0004](0004-acceptance-tester.md) rejected: the independent verifier alone, reading a test that the worker it checks wrote. We accept it only where the acceptance tester has nothing to use, because the alternative is no automatic evidence at all.

## Considered Options

- **Only human criteria in a repo with no app.** Rejected: the pull request becomes my review alone, and the factory adds little.
- **A mock server built from the contracts as the running app.** Rejected: it covers OpenAPI and not AsyncAPI, and the tester would only check that the mock answers what the contract says.
- **Give the acceptance tester the test to run.** Rejected: it would read a test of the workers, which ADR 0004 forbids, and it would judge the test, not the product.
- **Use `test` wherever a test is cheaper than Playwright.** Rejected: it would bring back, where the app could prove the criterion, the weakness that ADR 0004 removed.

## Consequences

- The pull request says in one line when no acceptance tester ran because no criterion needs a running app.
- `factory run` needs the credential of the acceptance tester only when a criterion has Playwright or request evidence.
- The independence of a `test` criterion rests on the clean context of the independent verifier alone.
- Holdout scenarios, if any, keep their own types.
- The rule of the refinement, `test` only when the app cannot prove the criterion, is checked by my review of the spec, not by code.
