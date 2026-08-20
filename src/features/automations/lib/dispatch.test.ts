// Firing one carried schedule.
//
// A schedule is carried by a PERSONA and fires into the pane that persona is running in. Every path
// through here records EXACTLY ONE run, because the run log is the only record that a fire happened
// — a path that returns without recording is a job that silently did nothing.
import { describe, it, expect, vi } from "vitest";
import { dispatchSchedule, type DispatchDeps } from "@/features/automations/lib/dispatch";
import type { CarriedSchedule } from "@/features/automations/lib/scheduler";

const sched = (over: Partial<CarriedSchedule> = {}): CarriedSchedule => ({
  personaId: "persona-nightly",
  name: "gc",
  when: { kind: "cron", expr: "0 2 * * *" },
  command: "npm run gc",
  ...over,
});

/** Deps with a pane running the carrier, unless overridden. */
function deps(over: Partial<DispatchDeps> = {}) {
  const runs: Array<[string, string, string, string]> = [];
  const d: DispatchDeps = {
    panePersonas: { t0p1: "persona-nightly" },
    disabledPanes: {},
    write: vi.fn(async () => {}),
    recordRun: (pane, schedule, status, note) => runs.push([pane, schedule, status, note]),
    ...over,
  };
  return { d, runs };
}

describe("dispatchSchedule", () => {
  it("writes the command into the pane running the CARRIER, with a trailing CR", async () => {
    const { d, runs } = deps();
    await dispatchSchedule(sched(), d);
    expect(d.write).toHaveBeenCalledWith("t0p1", "npm run gc\r");
    expect(runs).toEqual([["t0p1", "persona-nightly:gc", "ok", "ran in t0p1"]]);
  });

  it("finds the pane by IDENTITY, not position — a reordered pane still resolves", async () => {
    // The whole reason the target moved off (tab name, pane index): the index did not survive a
    // reorder, so a moved pane could silently point a job at somebody else's terminal.
    const { d } = deps({ panePersonas: { t3p2: "persona-nightly" } });
    await dispatchSchedule(sched(), d);
    expect(d.write).toHaveBeenCalledWith("t3p2", expect.stringContaining("npm run gc"));
  });

  it("records a SKIP — not silence — when the carrier is not running anywhere", async () => {
    const { d, runs } = deps({ panePersonas: {} });
    await dispatchSchedule(sched(), d);
    expect(d.write).not.toHaveBeenCalled();
    expect(runs).toHaveLength(1);
    expect(runs[0][2]).toBe("skipped");
    expect(runs[0][3]).toContain("persona-nightly");
  });

  it("treats a DISABLED pane as not running", async () => {
    const { d, runs } = deps({ disabledPanes: { t0p1: true } });
    await dispatchSchedule(sched(), d);
    expect(d.write).not.toHaveBeenCalled();
    expect(runs[0][2]).toBe("skipped");
  });

  it("records a FAIL for an empty command rather than writing a bare newline", async () => {
    const { d, runs } = deps();
    await dispatchSchedule(sched({ command: "   " }), d);
    expect(d.write).not.toHaveBeenCalled();
    expect(runs).toEqual([["t0p1", "persona-nightly:gc", "fail", "empty command"]]);
  });

  it("never throws — a write failure becomes a recorded FAIL", async () => {
    // A scheduler that dies on one bad job stops firing every other one.
    const { d, runs } = deps({ write: vi.fn(async () => { throw new Error("pty gone"); }) });
    await expect(dispatchSchedule(sched(), d)).resolves.toBeUndefined();
    expect(runs[0][2]).toBe("fail");
    expect(runs[0][3]).toContain("pty gone");
  });

  it("records exactly ONE run on every path", async () => {
    // The log is the only evidence a fire happened; two rows would double-count and none would read
    // as "never ran", which is what due-ness is computed from.
    for (const [over, dover] of [
      [{}, {}],
      [{ command: "" }, {}],
      [{}, { panePersonas: {} }],
      [{}, { write: vi.fn(async () => { throw new Error("x"); }) }],
    ] as const) {
      const { d, runs } = deps(dover);
      await dispatchSchedule(sched(over), d);
      expect(runs).toHaveLength(1);
    }
  });
});
