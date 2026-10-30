import { BASE_IMAGE_TAG, type ImageDocker } from "../../src/workers/images.ts";

export interface FakeWorkerImage {
  present?: boolean;
  label?: string | null;
}

export class FakeImageDocker implements ImageDocker {
  readonly user = { uid: 501, gid: 20 };
  readonly builds: string[][] = [];
  private readonly exitCodes: number[];
  private readonly baseImageId: string | null;
  private readonly worker: FakeWorkerImage;

  constructor(
    exitCodes: number[] = [],
    baseImageId: string | null = "sha256:0123456789abcdef0123456789abcdef",
    worker: FakeWorkerImage = {},
  ) {
    this.exitCodes = exitCodes;
    this.baseImageId = baseImageId;
    this.worker = worker;
  }

  async build(args: string[]): Promise<number> {
    this.builds.push(args);
    return this.exitCodes[this.builds.length - 1] ?? 0;
  }

  async id(reference: string): Promise<string | null> {
    if (reference === BASE_IMAGE_TAG) return this.baseImageId;
    return this.worker.present === false ? null : "sha256:fedcba9876543210fedcba9876543210";
  }

  async label(): Promise<string | null> {
    return this.worker.label === undefined ? this.baseImageId : this.worker.label;
  }
}
