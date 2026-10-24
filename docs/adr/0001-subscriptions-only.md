# Agents run only on subscriptions

The factory makes no paid API call. An agent enters the factory only if its CLI authenticates with a subscription, its credential reaches a container without the host session, it cannot fall back to pay-per-use when the plan limit is reached, and it runs only the models of its own provider. Today two agents meet this: the Claude Code CLI with a `claude setup-token` token of the Max plan, and the OpenCode CLI with an OpenCode Go key and only `opencode-go/` models, because `opencode/` is the pay-per-use Console. A future agent, such as Codex on a ChatGPT plan, enters only after these conditions are checked for it; with an API key it does not. This is why the agents are CLIs supervised in Docker instead of SDK calls, and why the run pauses at the plan limit instead of failing.

The same agent and model may serve several roles of a run (see [ADR 0003](0003-interchangeable-agents.md)), but each role runs in its own container, with only its credential and its own clean context: the independent verifier never shares a context with the workers.

## Considered Options

- **Mastra or the Claude Agent SDK.** Rejected: they need a paid API key, or a Claude.ai sign-in in a third-party app, which Anthropic does not permit.
- **Claude models through OpenCode.** Rejected: Anthropic and OpenCode both forbid it. The same holds for any provider's models through another provider's CLI.
