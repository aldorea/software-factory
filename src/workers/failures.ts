export const WORKER_LAYER_FAILURE_KINDS = [
  "container-start",
  "agent-end-undetected",
  "process-hang",
  "commit-or-cleanup",
  "usage-unreadable",
] as const;

export type WorkerLayerFailureKind = (typeof WORKER_LAYER_FAILURE_KINDS)[number];

export type WorkerLayerStage = "start" | "attempt" | "exec" | "close";

export class WorkerLayerError extends Error {
  readonly kind: WorkerLayerFailureKind;
  readonly stage: WorkerLayerStage;

  constructor(kind: WorkerLayerFailureKind, stage: WorkerLayerStage, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkerLayerError";
    this.kind = kind;
    this.stage = stage;
  }
}

const DEFAULT_KIND: Partial<Record<WorkerLayerStage, WorkerLayerFailureKind>> = {
  start: "container-start",
  close: "commit-or-cleanup",
};

export function asWorkerLayerError(stage: WorkerLayerStage, error: unknown): unknown {
  if (error instanceof WorkerLayerError) return error;
  const kind = DEFAULT_KIND[stage];
  if (kind === undefined) return error;
  return new WorkerLayerError(kind, stage, error instanceof Error ? error.message : String(error), { cause: error });
}

export async function inStage<T>(stage: WorkerLayerStage, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw asWorkerLayerError(stage, error);
  }
}
