// The invoke TALLY (#the-invoke-boundary-counts-what-the-app-actually-calls) — the counting half of
// `invokeTiming`, which `invokeTiming.test.ts`'s carried entry does not cover.
//
// ON DISK rather than carried on the record: request #399 records that no bsc verb writes a record's
// `tests[]` into the COMMITTED store — `impl set --repo` has no `--tests-file` and `tests set` reaches
// only the runtime ledger — so a committed test must be a file. Named `invokeTally` rather than
// `invokeTiming` ON PURPOSE: an on-disk test file SHADOWS a record's emitted test of the same name,
// and `invoke-timing.ts` already carries one.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  tally,
  drainTallies,
  setInvokeScope,
  startInvokeTimer,
  FLUSH_LABEL,
  SLOW_INVOKE_MS,
  type InvokeTally,
} from "@/shared/lib/core/invokeTiming";

const fresh = () => new Map<string, InvokeTally>();

describe("tally", () => {
  it("counts a call and keeps its time span", () => {
    const m = tally(fresh(), "logs_tail", "logs", 12, 1_000);
    const row = [...m.values()][0];
    expect(row).toMatchObject({ command: "logs_tail", scope: "logs", n: 1, ms: 12, first: 1_000, last: 1_000 });
  });

  it("sums repeats into one row and widens only the LAST timestamp", () => {
    const m = fresh();
    tally(m, "logs_tail", "logs", 10, 1_000);
    tally(m, "logs_tail", "logs", 30, 5_000);
    expect([...m.values()]).toEqual([
      { command: "logs_tail", scope: "logs", n: 2, ms: 40, first: 1_000, last: 5_000 },
    ]);
  });

  it("keys on scope too, so one command under two UIs is two rows", () => {
    const m = fresh();
    tally(m, "bsc", "jobs", 5, 1);
    tally(m, "bsc", "glance", 5, 1);
    expect(m.size).toBe(2);
  });

  it("drops an EXCLUDED command, so the logging subsystem does not measure itself", () => {
    const m = fresh();
    tally(m, "frontend_log", "logs", 5, 1);
    tally(m, "log_get_scopes", "logs", 5, 1);
    expect(m.size).toBe(0);
  });

  // The flush rides the `bsc` bridge, so excluding the COMMAND would stop counting every bridge call in
  // the app — most of what the tally is for. It is excluded by LABEL, and this is what pins that.
  it("drops the flush by LABEL while still counting other bsc calls", () => {
    const m = fresh();
    tally(m, "bsc", "logs", 5, 1, FLUSH_LABEL);
    expect(m.size, "the flush itself is not counted").toBe(0);

    tally(m, "bsc", "logs", 5, 1, "bsc plan list");
    expect(m.size, "but another bsc call is").toBe(1);
    expect([...m.values()][0].command).toBe("bsc");
  });
});

describe("drainTallies", () => {
  beforeEach(() => {
    drainTallies();
    setInvokeScope("");
  });

  it("returns the rows and CLEARS them, so a window is never counted twice", () => {
    startInvokeTimer("logs_tail")();
    expect(drainTallies().length).toBe(1);
    expect(drainTallies(), "a second drain sees an empty tally").toEqual([]);
  });

  it("attributes to the scope that was set when the call completed", () => {
    setInvokeScope("jobs");
    startInvokeTimer("logs_tail")();
    expect(drainTallies()[0].scope).toBe("jobs");
  });

  // THE ORDERING GUARD. `startInvokeTimer`'s closure early-returns for anything under
  // `SLOW_INVOKE_MS`, so counting has to happen ABOVE that return. Move the tally below it and this
  // fails while every other test here still passes — the tally would silently hold only slow calls,
  // and "is this command hot" would be answered by call COST instead of call COUNT.
  it("counts a call FASTER than the slow threshold", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValueOnce(0).mockReturnValueOnce(SLOW_INVOKE_MS / 10);
    startInvokeTimer("a_fast_command")();
    now.mockRestore();

    const rows = drainTallies();
    expect(rows.length, "a sub-threshold call is still counted").toBe(1);
    expect(rows[0].command).toBe("a_fast_command");
    expect(rows[0].ms).toBeLessThan(SLOW_INVOKE_MS);
  });
});
