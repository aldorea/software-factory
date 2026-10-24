import { describe, expect, it } from "vitest";
import { Lock, inSlots } from "../../src/coordinator/slots.ts";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("inSlots", () => {
  it("should never run more tasks at once than the limit", async () => {
    let active = 0;
    let peak = 0;

    await inSlots([1, 2, 3, 4, 5], 2, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await pause(20);
      active -= 1;
    });

    expect(peak).toBe(2);
  });

  it("should give the tasks that run at the same time different slots from 0 up, and reuse a slot once it is free", async () => {
    const slotOf = new Map<number, number>();

    await inSlots([1, 2, 3], 2, async (item, slot) => {
      slotOf.set(item, slot);
      await pause(item === 1 ? 60 : 10);
    });

    expect(slotOf.get(1)).toBe(0);
    expect(slotOf.get(2)).toBe(1);
    expect(slotOf.get(3)).toBe(1);
  });

  it("should run every task even when the limit is above the number of tasks", async () => {
    const seen: number[] = [];

    await inSlots([1, 2], 5, async (item) => {
      seen.push(item);
    });

    expect(seen.sort()).toEqual([1, 2]);
  });

  it("should let the running tasks finish and then throw the first failure", async () => {
    const finished: number[] = [];

    const result = inSlots([1, 2], 2, async (item) => {
      if (item === 1) throw new Error("broken precondition");
      await pause(30);
      finished.push(item);
    });

    await expect(result).rejects.toThrow("broken precondition");
    expect(finished).toEqual([2]);
  });
});

describe("Lock", () => {
  it("should run the sections one at a time in the order they asked", async () => {
    const lock = new Lock();
    const events: string[] = [];

    await Promise.all(
      ["a", "b", "c"].map((name) =>
        lock.exclusive(async () => {
          events.push(`${name} in`);
          await pause(10);
          events.push(`${name} out`);
        }),
      ),
    );

    expect(events).toEqual(["a in", "a out", "b in", "b out", "c in", "c out"]);
  });

  it("should release the lock when a section throws", async () => {
    const lock = new Lock();

    await expect(lock.exclusive(async () => Promise.reject(new Error("failed")))).rejects.toThrow("failed");

    await expect(lock.exclusive(async () => "next")).resolves.toBe("next");
  });
});
