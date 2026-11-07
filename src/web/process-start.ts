import { execFile } from "node:child_process";

export type ProcessStartTime = (pid: number) => Promise<string | null>;

export const processStartTime: ProcessStartTime = (pid) =>
  new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      resolve(null);
      return;
    }
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => {
      const started = stdout.trim();
      resolve(error !== null || started === "" ? null : started);
    });
  });
