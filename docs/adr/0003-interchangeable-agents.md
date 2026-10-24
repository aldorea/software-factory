# Agents are interchangeable and chosen per role before each command

The factory runs on more than one subscription, so that no role depends on a single provider and new agents can join later. Each agent has an adapter in the worker layer, and the developer chooses the agent and the model of each role (the workers of a run, the independent verifier) before a command starts: from the command's flags, an interactive prompt, or the default of `.factory/config.ts`, and the command refuses to start when none gives one. The workers and the independent verifier may use the same agent and model; the verifier stays independent because it runs in its own clean context and receives only the criterion and its test. The refinement stays on Claude Code until its skill is shown to work on another agent.

An agent can serve as the workers only if its adapter reads its token usage and detects its plan limit, so that the hard limits and the pause apply to it. It can serve as the independent verifier only if it can be denied every tool and fails closed when that denial does not load.

## Considered Options

- **One fixed agent per role.** Rejected: it ties each role to one provider and leaves a second subscription unused.
- **Automatic switch to another agent at the plan limit.** Rejected for now: it mixes the attempts of two models in one subtask and makes patience harder to read. The developer may change the agent when resuming a paused run.
- **A choice per subtask.** Rejected: it multiplies the prompts and the limits with no clear gain.
- **Forcing the verifier onto a different model from the workers.** Rejected: the developer decides, and the clean context is what makes the verifier independent.
