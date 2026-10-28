const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(then: Date, now: Date): string {
  const elapsed = Math.max(0, now.getTime() - then.getTime());
  if (elapsed < MINUTE) return "hace un momento";
  if (elapsed < HOUR) return `hace ${Math.floor(elapsed / MINUTE)} min`;
  if (elapsed < DAY) return `hace ${Math.floor(elapsed / HOUR)} h`;
  return `hace ${Math.floor(elapsed / DAY)} d`;
}
