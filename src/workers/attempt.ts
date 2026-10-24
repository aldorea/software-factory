import type { AgentAdapter } from "./agent-adapter.ts";
import { supervise } from "./supervise.ts";
import type { AttemptLimits, AttemptResult } from "./types.ts";

export interface AttemptRequest {
  adapter: AgentAdapter;
  model: string;
  prompt: string;
  limits: AttemptLimits;
  logPath: string;
  launch: (agentCommand: string[]) => { command: string; args: string[] };
  stop: (processName: string) => Promise<void>;
}

export async function performAttempt(request: AttemptRequest): Promise<AttemptResult> {
  const { adapter } = request;
  const startedAt = new Date();
  const stream = adapter.createStream();
  const { command, args } = request.launch(adapter.command(request.model));
  const supervised = await supervise({
    command,
    args,
    stdin: request.prompt,
    logPath: request.logPath,
    deadline: request.limits.deadline,
    idleTimeoutMs: request.limits.idleTimeoutMs,
    onLine: (line) => stream.onLine(line),
    ...(adapter.isFinalLine ? { isFinalLine: adapter.isFinalLine } : {}),
    terminate: () => request.stop(adapter.processName),
  });
  const plan = stream.plan();
  return {
    outcome: stream.outcome(supervised),
    usage: stream.usage(),
    ...(plan ? { plan } : {}),
    logPath: request.logPath,
    startedAt,
    endedAt: new Date(),
  };
}
