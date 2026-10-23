export type AgentKind = "claude-code" | "opencode";

export interface AgentSpec {
  kind: AgentKind;
  model: string;
}

export interface WorkerSpec {
  id: string;
  repoDir: string;
  baseRef: string;
  branch: string;
  image: string;
  env: Record<string, string>;
  logDir: string;
}

export interface AttemptLimits {
  deadline: Date;
  idleTimeoutMs: number;
}

export interface TokenUsage {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
}

export interface PlanWindow {
  utilization: number;
  resetsAt: Date;
}

export interface PlanStatus {
  status: string;
  limitType?: string;
  resetsAt?: Date;
  windows: Record<string, PlanWindow>;
}

export type AttemptOutcome =
  | { kind: "completed"; summary: string }
  | { kind: "plan-limit"; message: string; resetsAt?: Date }
  | { kind: "deadline" }
  | { kind: "idle-timeout" }
  | { kind: "agent-error"; message: string; exitCode: number | null };

export interface AttemptResult {
  outcome: AttemptOutcome;
  usage: TokenUsage;
  plan?: PlanStatus;
  logPath: string;
  startedAt: Date;
  endedAt: Date;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CloseResult {
  preservedWorktreePath?: string;
}

export interface Worker {
  readonly spec: WorkerSpec;
  readonly worktreePath: string;
  runAgent(agent: AgentSpec, prompt: string, limits: AttemptLimits): Promise<AttemptResult>;
  exec(command: string, options?: { timeoutMs?: number }): Promise<ExecResult>;
  commits(): Promise<string[]>;
  close(): Promise<CloseResult>;
}

export interface WorkerRunner {
  start(spec: WorkerSpec): Promise<Worker>;
}
