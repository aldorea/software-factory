import type { ImageDocker } from "../../src/workers/images.ts";

export class FakeImageDocker implements ImageDocker {
  readonly user = { uid: 501, gid: 20 };
  readonly builds: string[][] = [];
  private readonly exitCodes: number[];
  private readonly baseImageId: string | null;

  constructor(exitCodes: number[] = [], baseImageId: string | null = "sha256:0123456789abcdef0123456789abcdef") {
    this.exitCodes = exitCodes;
    this.baseImageId = baseImageId;
  }

  async build(args: string[]): Promise<number> {
    this.builds.push(args);
    return this.exitCodes[this.builds.length - 1] ?? 0;
  }

  async id(): Promise<string | null> {
    return this.baseImageId;
  }
}
