import { readFileSync } from "node:fs";

function isZombie(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").startsWith("Z");
  } catch {
    return false;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return !isZombie(pid);
}
