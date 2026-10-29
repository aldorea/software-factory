import type { AgentAdapter, AgentStream } from "./agent-adapter.ts";
import { WorkerLayerError } from "./failures.ts";
import { supervise } from "./supervise.ts";
import { readUsage } from "./usage.ts";
import type { ActivitySink, AttemptLimits, AttemptOutcome, AttemptResult, ExecResult, TokenUsage } from "./types.ts";

export interface AttemptRequest {
  adapter: AgentAdapter;
  model: string;
  prompt: string;
  limits: AttemptLimits;
  logPath: string;
  onActivity?: ActivitySink;
  launch: (agentCommand: string[]) => { command: string; args: string[] };
  stop: (processName: string) => Promise<void>;
  exec: (command: string[]) => Promise<ExecResult>;
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
    onLine: (line) => {
      stream.onLine(line);
      if (request.onActivity === undefined) return;
      for (const event of stream.activity?.(line) ?? []) request.onActivity(event);
    },
    ...(adapter.isFinalLine ? { isFinalLine: adapter.isFinalLine } : {}),
    terminate: () => request.stop(adapter.processName),
  });
  const plan = stream.plan();
  const outcome = stream.outcome(supervised);
  return {
    outcome,
    usage: await usageOf(request, stream, outcome),
    ...(plan ? { plan } : {}),
    logPath: request.logPath,
    startedAt,
    endedAt: new Date(),
  };
}

async function usageOf(request: AttemptRequest, stream: AgentStream, outcome: AttemptOutcome): Promise<TokenUsage> {
  if (stream.usageProbe === undefined) return stream.usage();
  const reading = await readUsage(stream.usageProbe, stream.usage(), outcome, request.exec);
  if (reading.ok) return reading.usage;
  throw new WorkerLayerError(
    "usage-unreadable",
    "attempt",
    `The token usage of ${request.adapter.kind} cannot be read: ${reading.problem}`,
  );
}
