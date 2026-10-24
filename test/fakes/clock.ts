import type { Clock } from "../../src/coordinator/ports.ts";

export class FakeClock implements Clock {
  private current: number;

  constructor(start: string) {
    this.current = Date.parse(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
