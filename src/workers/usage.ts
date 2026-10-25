import type { UsageProbe, UsageReading } from "./agent-adapter.ts";
import type { AttemptOutcome, ExecResult, TokenUsage } from "./types.ts";

export async function readUsage(
  probe: UsageProbe,
  fallback: TokenUsage,
  outcome: AttemptOutcome,
  exec: (command: string[]) => Promise<ExecResult>,
): Promise<UsageReading> {
  const command = probe.command();
  if (command === undefined) {
    if (outcome.kind === "completed") return { ok: false, problem: "the agent completed with no session to read its token usage from" };
    return { ok: true, usage: fallback };
  }
  const result = await exec(command);
  if (result.exitCode !== 0) {
    return { ok: false, problem: `${command.join(" ")} exited with ${result.exitCode}: ${result.stderr.trim()}` };
  }
  return probe.parse(result.stdout);
}
