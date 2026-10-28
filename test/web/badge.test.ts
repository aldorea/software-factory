import { describe, expect, it } from "vitest";
import { badge } from "../../src/web/html.ts";

describe("badge", () => {
  it("should colour a ready run as ok and a blocked subtask as bad", () => {
    expect(badge("ready")).toBe('<span class="badge ok">ready</span>');
    expect(badge("blocked")).toBe('<span class="badge bad">blocked</span>');
  });

  it("should give an unknown value the muted colour and escape it, because the value comes from run.json", () => {
    expect(badge('x" onmouseover="y')).toBe('<span class="badge muted">x&quot; onmouseover=&quot;y</span>');
  });

  it("should not take a colour from a property of Object, because a run.json value can be any string", () => {
    expect(badge("constructor")).toBe('<span class="badge muted">constructor</span>');
  });
});
