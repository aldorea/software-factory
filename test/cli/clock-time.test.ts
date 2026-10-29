import { describe, expect, it } from "vitest";
import { clockMinutes, clockTime, twoDigits } from "../../src/cli/clock-time.ts";

describe("clock time", () => {
  it("should pad a number to two digits", () => {
    expect(twoDigits(4)).toBe("04");
    expect(twoDigits(12)).toBe("12");
  });

  it("should write the local time as hh:mm:ss", () => {
    expect(clockTime(new Date(2026, 9, 28, 4, 5, 9))).toBe("04:05:09");
  });

  it("should write the local time as hh:mm when seconds do not matter", () => {
    expect(clockMinutes(new Date(2026, 9, 28, 4, 5, 9))).toBe("04:05");
  });
});
