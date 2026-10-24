# Agents run only on subscriptions

The factory makes no paid API call: workers run the Claude Code CLI with a `claude setup-token` token of the Max plan, and the independent verifier runs the OpenCode CLI with an OpenCode Go key and only `opencode-go/` models, because `opencode/` is the pay-per-use Console. This is why the agents are CLIs supervised in Docker instead of SDK calls, and why the run pauses at the plan limit instead of failing.

## Considered Options

- **Mastra or the Claude Agent SDK.** Rejected: they need a paid API key, or a Claude.ai sign-in in a third-party app, which Anthropic does not permit.
- **Claude models through OpenCode.** Rejected: Anthropic and OpenCode both forbid it.
