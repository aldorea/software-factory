import { describe, expect, it } from "vitest";
import { planLimitAnnotate, planLimitReached, planLimitWarning } from "../../src/cli/plan-limit-warning.ts";
import { initialMenu, reduceMenu, renderMenu, type MenuKey, type RoleEntry } from "../../src/cli/role-menu.ts";
import { pausedRun, runRecord, subtaskRecord } from "../coordinator/run-log-fixtures.ts";

const RESETS_AT = new Date(2026, 9, 29, 14, 0, 0);
const BEFORE = new Date(2026, 9, 29, 13, 59, 59);
const MODELS = { "claude-code": ["opus", "sonnet"], opencode: ["opencode-go/kimi-k3"] };
const BOTH = ["claude-code", "opencode"] as const;

const ENTRIES: RoleEntry[] = [
  { role: "workers", offered: [...BOTH], choice: { agent: "claude-code", model: "opus" }, origin: "paused run" },
  { role: "verifier", offered: [...BOTH], choice: { agent: "opencode", model: "opencode-go/glm-5.3" }, origin: "config" },
  { role: "tester", offered: [...BOTH], choice: { agent: "opencode", model: "opencode-go/qwen3.8-max" }, origin: "flag" },
];

function pausedAt(resetsAt: Date | undefined) {
  return { ...pausedRun(1), ...(resetsAt !== undefined ? { resetsAt: resetsAt.toISOString() } : {}) };
}

describe("planLimitWarning", () => {
  const limit = { agent: "claude-code", resetsAt: RESETS_AT } as const;

  it("should warn that the run will pause again while now is before the reset", () => {
    expect(planLimitWarning(limit, BEFORE)).toBe("⚠ claude-code plan limit until 14:00: the run will pause again");
  });

  it("should not warn at the reset time or after it", () => {
    expect(planLimitWarning(limit, RESETS_AT)).toBeNull();
    expect(planLimitWarning(limit, new Date(2026, 9, 29, 14, 0, 1))).toBeNull();
  });

  it("should write the time of the reset with two digits for the hour and the minutes", () => {
    expect(planLimitWarning({ agent: "opencode", resetsAt: new Date(2026, 9, 29, 9, 5) }, new Date(2026, 9, 29, 8, 0))).toBe(
      "⚠ opencode plan limit until 09:05: the run will pause again",
    );
  });
});

describe("planLimitReached", () => {
  it("should take the agent of the last pause and the reset time of a paused run", () => {
    expect(planLimitReached(pausedAt(RESETS_AT))).toEqual({ agent: "claude-code", resetsAt: RESETS_AT });
  });

  it("should find no limit in a new run, in a run that is not paused or in a pause with no reset time", () => {
    expect(planLimitReached(null)).toBeNull();
    expect(planLimitReached({ ...pausedAt(RESETS_AT), result: "ready" })).toBeNull();
    expect(planLimitReached(pausedAt(undefined))).toBeNull();
  });

  it("should find no limit in a paused run that no agent paused", () => {
    const { pauses: _pauses, ...unlimited } = pausedAt(RESETS_AT);

    expect(planLimitReached(unlimited)).toBeNull();
    expect(planLimitReached({ ...unlimited, pauses: [] })).toBeNull();
  });

  it("should find no limit when the reset time is not a date", () => {
    expect(planLimitReached({ ...pausedRun(1), resetsAt: "later" })).toBeNull();
  });
});

describe("planLimitAnnotate", () => {
  it("should put the warning once, under the first role that still holds the agent that reached the limit, so the summary does not repeat it", () => {
    const entries = ENTRIES.map((entry) => ({ ...entry, choice: { agent: "claude-code", model: "sonnet" } }) as RoleEntry);
    const notes = planLimitAnnotate(pausedAt(RESETS_AT), BEFORE)(entries);
    const warning = "⚠ claude-code plan limit until 14:00: the run will pause again";

    expect(notes).toEqual({ workers: [warning] });
  });

  it("should put the warning under a later role when the earlier roles hold another agent", () => {
    const [workers, verifier, tester] = ENTRIES as [RoleEntry, RoleEntry, RoleEntry];
    const entries: RoleEntry[] = [workers, { ...verifier, choice: { agent: "claude-code", model: "sonnet" } }, { ...tester, choice: { agent: "claude-code", model: "sonnet" } }];
    const notes = planLimitAnnotate(pausedAt(RESETS_AT), BEFORE)([{ ...workers, choice: { agent: "opencode", model: "opencode-go/glm-5.3" } }, ...entries.slice(1)]);

    expect(Object.keys(notes)).toEqual(["verifier"]);
  });

  it("should warn about nothing after the reset, in a new run or in a run paused for another reason", () => {
    const another = runRecord(1, [subtaskRecord("S1", { state: "pending" })], { result: "paused", pauseReason: "something else" });

    expect(planLimitAnnotate(pausedAt(RESETS_AT), RESETS_AT)(ENTRIES)).toEqual({});
    expect(planLimitAnnotate(null, BEFORE)(ENTRIES)).toEqual({});
    expect(planLimitAnnotate(another, BEFORE)(ENTRIES)).toEqual({});
  });
});

describe("the role menu with the plan limit warning", () => {
  const menu = () => initialMenu(ENTRIES, MODELS, planLimitAnnotate(pausedAt(RESETS_AT), BEFORE));
  const press = (...keys: MenuKey[]) => keys.reduce(reduceMenu, menu());

  it("should show the warning under the workers in the summary", () => {
    expect(renderMenu(menu())[1]).toBe("  ⚠ claude-code plan limit until 14:00: the run will pause again");
  });

  it("should drop the warning when the developer changes the role to another agent", () => {
    const changed = press("right", "down", "down", "down", "enter");

    expect(changed.entries[0]?.choice?.agent).toBe("opencode");
    expect(renderMenu(changed).join("\n")).not.toContain("plan limit");
  });

  it("should start on Enter although the summary shows the warning, because the warning never blocks", () => {
    expect(press("enter").outcome).toBe("started");
  });
});
