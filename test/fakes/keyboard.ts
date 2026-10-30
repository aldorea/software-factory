import { PassThrough, Writable } from "node:stream";
import type { KeyInput } from "../../src/cli/tty.ts";

export interface FakeKeyboard extends KeyInput {
  raw: boolean[];
  type(text: string): void;
}

export function fakeKeyboard(): FakeKeyboard {
  const stream = new PassThrough();
  const raw: boolean[] = [];
  return Object.assign(stream, {
    raw,
    setRawMode(mode: boolean) {
      raw.push(mode);
      return stream;
    },
    type(text: string) {
      stream.write(text);
    },
  });
}

export function textSink(): { stream: Writable; text(): string } {
  let written = "";
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      written += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => written };
}

export async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
