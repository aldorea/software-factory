import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempDirs {
  make(prefix: string): Promise<string>;
  removeAll(): Promise<void>;
  keepAll(): void;
}

export function tempDirs(): TempDirs {
  const created: string[] = [];
  return {
    async make(prefix) {
      const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
      created.push(dir);
      return dir;
    },
    async removeAll() {
      await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    },
    keepAll() {
      created.splice(0);
    },
  };
}
