export async function runInSlots<T>(
  items: readonly T[],
  limit: number,
  task: (item: T, slot: number) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const lane = async (slot: number): Promise<void> => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await task(item, slot);
  };
  const lanes = Array.from({ length: Math.min(limit, items.length) }, (_, slot) => lane(slot));
  const settled = await Promise.allSettled(lanes);
  for (const result of settled) {
    if (result.status === "rejected") throw result.reason;
  }
}

export class Lock {
  private tail: Promise<unknown> = Promise.resolve();

  exclusive<T>(section: () => Promise<T>): Promise<T> {
    const result = this.tail.then(section, section);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
