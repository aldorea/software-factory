import type { AgentAdapter, AgentStream } from "./agent-adapter.ts";
import { WorkerLayerError } from "./failures.ts";
import { supervise } from "./supervise.ts";
import type { AttemptLimits, AttemptOutcome, AttemptResult, ExecResult, TokenUsage } from "./types.ts";

export interface AttemptRequest {
  adapter: AgentAdapter;
  model: string;
  prompt: string;
  limits: AttemptLimits;
  logPath: string;
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
    onLine: (line) => stream.onLine(line),
    ...(adapter.isFinalLine ? { isFinalLine: adapter.isFinalLine } : {}),
    terminate: () => request.stop(adapter.processName),
  });
  const plan = stream.plan();
  const outcome = stream.outcome(supervised);
  return {
    outcome,
    usage: await readUsage(request, stream, outcome),
    ...(plan ? { plan } : {}),
    logPath: request.logPath,
    startedAt,
    endedAt: new Date(),
  };
}

async function readUsage(request: AttemptRequest, stream: AgentStream, outcome: AttemptOutcome): Promise<TokenUsage> {
  const probe = stream.usageProbe;
  if (probe === undefined) return stream.usage();
  const command = probe.command();
  if (command === undefined) {
    if (outcome.kind === "completed") {
      throw unreadable(request, "the agent completed with no session to read its token usage from");
    }
    return stream.usage();
  }
  const result = await request.exec(command);
  if (result.exitCode !== 0) {
    throw unreadable(request, `${command.join(" ")} exited with ${result.exitCode}: ${result.stderr.trim()}`);
  }
  const reading = probe.parse(result.stdout);
  if (!reading.ok) throw unreadable(request, reading.problem);
  return reading.usage;
}

function unreadable(request: AttemptRequest, problem: string): WorkerLayerError {
  return new WorkerLayerError("usage-unreadable", "attempt", `The token usage of ${request.adapter.kind} cannot be read: ${problem}`);
}
