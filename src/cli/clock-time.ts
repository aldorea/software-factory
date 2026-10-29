export function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

export function clockMinutes(at: Date): string {
  return `${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}`;
}

export function clockTime(at: Date): string {
  return `${clockMinutes(at)}:${twoDigits(at.getSeconds())}`;
}
