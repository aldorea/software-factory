---
name: refine
description: Refine a GitHub issue of this target repo into a spec the software factory can run. Use when the developer starts `factory refine <n>`, or asks to refine issue <n> for the factory.
argument-hint: <issue number>
---

# Refine an issue into a spec

You are in the worktree of the integration branch `factory/<n>-<slug>` of the target repo, started by `factory refine <n>`. `<n>` is the argument of this skill. The developer is at the terminal. Your job is to turn issue `<n>` into a spec that `factory run` can execute without asking anything else.

The environment variable `FACTORY_CLI` holds the path of the factory CLI. Run it as `node "$FACTORY_CLI" <command>`.

Use the terms of the factory: criterion, subtask, base subtask, scope paths, wave, evidence, level. The format of the spec is defined by the validator, not by this text: when they disagree, the validator wins.

## 1. Read

1. Read the issue: `gh issue view <n> --json number,title,body,labels,comments`.
2. Read the code that the issue touches: the structure, the files it will change, the existing tests, the checks of the repo, `.factory/config.ts` (the protected paths).
3. Read `specs/<n>.md` if it exists: this may be a second session on the same issue. Start from it, do not start over.

Write the technical part yourself from what you read. Do not ask the developer for anything the code answers.

## 2. Ask only the open decisions

Ask about product decisions, ambiguities in the issue and criteria that are doubtful: not testable, too broad, two criteria in one, or in conflict.

- Ask in rounds. Each round holds the questions that do not depend on each other, numbered, in plain words.
- Give each question its context (what is being decided and why it matters) and your recommended answer.
- After each round, update your understanding and ask a new round only if something is still open. Stop when nothing is.
- Keep a list of each decision and the reason the developer gave. You post it at the end.

## 3. Rewrite the criteria of the issue

Edit the issue so its "Acceptance criteria" section holds the final criteria, each with an ID `A1`, `A2`… in this form:

```
## Acceptance criteria

- [ ] A1 <one testable behaviour>
- [ ] A2 <one testable behaviour>
```

- One behaviour per criterion, observable from outside, written so that a test can pass or fail it.
- Keep the criteria the developer already agreed; change one only when a decision of step 2 says so.
- Apply it with `gh issue edit <n> --body-file <file>`, keeping every other part of the body as it is. Show the developer the final list before you apply it.

## 4. Partition by scope

List the files that each criterion touches (`files`). Then group the criteria:

- What every criterion touches (schema, shared helpers, contracts with a stub body, new dependencies) goes to the base subtask. It runs first and alone. Only it may change the protected paths of `.factory/config.ts`, the lockfile and the `package.json` files.
- Criteria that share a file go to the same subtask.
- Subtasks that can run in the same wave must have disjoint scope paths. If two subtasks overlap, make one depend on the other with `dependsOn`, or merge them.
- One or two criteria make one subtask and no base (`"base": null`).
- A subtask lists in `testChanges` the existing test files that it must change; everything else about existing tests stays frozen.

## 5. Give each criterion its evidence

Each criterion gets one type of evidence and one level:

- `playwright`: an e2e test that passes.
- `request`: a request to an endpoint and the comparison of its response with the expected one. The base subtask writes these checks, because it fixes the contracts.
- `human`: only for a visual or subjective criterion that you cannot turn into one of the other two. It needs a `reason`. Try hard to convert it first.

Level is `subtask` (the subtask can verify it alone) or `integration` (it needs the integrated app).

## 6. Write `specs/<n>.md` and validate it

`specs/<n>.md` refers to the criteria by ID and never copies their text. It has a short prose introduction for the developer and exactly one machine block:

````
```json factory-spec
{
  "files": { "A1": ["src/a.ts"], "A2": ["src/b.ts"] },
  "base": null,
  "subtasks": [
    { "id": "main", "criteria": ["A1", "A2"], "scope": ["src/"], "dependsOn": [], "testChanges": [] }
  ],
  "criteria": {
    "A1": { "evidence": "playwright", "level": "integration" },
    "A2": { "evidence": "human", "level": "integration", "reason": "Why a person must judge it." }
  }
}
```
````

Then:

1. Commit it on this branch: `git add specs/<n>.md && git commit -m "Spec #<n>"`. The validator reads the committed file.
2. Run `node "$FACTORY_CLI" validate <n>`.
3. If it fails, read each problem, fix the spec or the criteria, commit again and run it again. Do this until it prints that the spec is valid.

You do not finish while `node "$FACTORY_CLI" validate <n>` fails. If a problem needs a decision from the developer, ask it. If you cannot make it pass, say so plainly and stop with the failure on screen: never tell the developer the spec is ready.

Do not run `factory approve`: the developer does it after reading the spec.

## 7. Post the decisions

Post one comment on the issue with `gh issue comment <n> --body-file <file>`: the decisions of step 2 and the reason of each, and any criterion you changed, split or removed and why. If there were no decisions, say that.

## 8. Hand back

Tell the developer, in a few lines: the path of `specs/<n>.md`, the number of subtasks and whether there is a base, the criteria that need human evidence, and that the next step is to read the spec and run `factory approve <n>`. If you touched the spec or the criteria after the last `validate`, run `node "$FACTORY_CLI" validate <n>` again before this message: the last check you ran must be one that succeeded.
