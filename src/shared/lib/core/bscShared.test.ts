// #five-callers-one-spawn-for-the-same-plan-read — coalesced `bsc` reads.
//
// Every assertion here counts SPAWNS, because that is the whole point: the data was always correct, and
// five callers were each launching a process for the same bytes (measured: `plan list --full`, 113 calls,
// 57.9s). A cache that returned the right answer while still spawning would pass a data test and fix
// nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { bscJsonShared, clearBscShared } from "./bscShared";
import * as bscMod from "./bsc";

/** A `bscJson` that resolves IMMEDIATELY — the spy is the spawn counter. Resolving without a timer keeps
 *  it usable under fake timers, which the TTL tests need (the TTL reads `Date.now()`). */
function stubRead<T>(value: T) {
  const spy = vi.spyOn(bscMod, "bsc").mockResolvedValue(JSON.stringify(value));
  spy.mockClear();   // spyOn re-applied in one test returns the SAME spy, history included
  return spy;
}

/** A `bscJson` held open until released — for proving the in-flight join without relying on timing. */
function stubPending<T>(value: T) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const spy = vi.spyOn(bscMod, "bsc").mockImplementation(() => gate.then(() => JSON.stringify(value)));
  spy.mockClear();
  return { spy, release };
}

/** A `bsc` returning exact stdout — for the empty-output case, which is not valid JSON. */
function stubRawOut(out: string) {
  const spy = vi.spyOn(bscMod, "bsc").mockResolvedValue(out);
  spy.mockClear();
  return spy;
}

beforeEach(() => { clearBscShared(); vi.restoreAllMocks(); });
afterEach(() => vi.useRealTimers());

describe("in-flight join", () => {
  it("collapses concurrent identical reads into ONE spawn", async () => {
    // The unconditional half — no TTL needed. Two identical reads at the same moment must never be two
    // processes. This is the five-hooks-on-one-tick case.
    const { spy, release } = stubPending([{ ref: "a" }]);
    const pending = Array.from({ length: 5 }, () =>
      bscJsonShared("proj", ["plan", "list", "--full", "--json"], [], 0),
    );
    release();
    const all = await Promise.all(pending);
    expect(spy).toHaveBeenCalledTimes(1);
    for (const r of all) expect(r).toEqual([{ ref: "a" }]);
  });

  it("does not join reads that are not the same command", async () => {
    const { spy, release } = stubPending(["x"]);
    release();
    await Promise.all([
      bscJsonShared("proj", ["plan", "list", "--full"], [], 0),
      bscJsonShared("proj", ["plan", "list"], [], 0),          // a DIFFERENT command
      bscJsonShared("other", ["plan", "list", "--full"], [], 0), // …and a different project
    ]);
    expect(spy).toHaveBeenCalledTimes(3);
  });
});

describe("TTL reuse", () => {
  it("serves a fresh reading without spawning at all", async () => {
    const spy = stubRead(["v1"]);
    await bscJsonShared("p", ["plan", "list"], [], 20_000);
    const second = await bscJsonShared("p", ["plan", "list"], [], 20_000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(second).toEqual(["v1"]);
  });

  it("spawns again once the caller's window has passed", async () => {
    vi.useFakeTimers();
    const spy = stubRead(["v1"]);
    await bscJsonShared("p", ["plan", "list"], [], 1_000);
    vi.setSystemTime(Date.now() + 1_500);
    await bscJsonShared("p", ["plan", "list"], [], 1_000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("lets EACH CALLER state its own tolerance — a stricter one is not served a stale value", async () => {
    // The TTL belongs to the caller, so a site that needs fresher data says so and gets it. That is what
    // makes this safe to apply to sites with different cadences.
    vi.useFakeTimers();
    const spy = stubRead(["v1"]);
    await bscJsonShared("p", ["plan", "list"], [], 20_000);
    vi.setSystemTime(Date.now() + 5_000);
    await bscJsonShared("p", ["plan", "list"], [], 1_000);   // only tolerates 1s — must re-read
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("ttl 0 keeps the in-flight join but never reuses a landed value", async () => {
    const spy = stubRead(["v1"]);
    await bscJsonShared("p", ["plan", "list"], [], 0);
    await bscJsonShared("p", ["plan", "list"], [], 0);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("failures are not cached", () => {
  it("does NOT pin a failure for the window — the next caller retries", async () => {
    const spy = vi
      .spyOn(bscMod, "bsc")
      .mockRejectedValueOnce(new Error("bridge down"))
      .mockResolvedValueOnce(JSON.stringify(["real"]));
    spy.mockClear();

    expect(await bscJsonShared<string[]>("p", ["plan", "list"], [], 20_000)).toEqual([]);
    const second = await bscJsonShared<string[]>("p", ["plan", "list"], [], 20_000);
    expect(second, "a transient failure must not pin the fallback").toEqual(["real"]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("gives EACH joiner its OWN fallback — the bug that shipped in the first draft", async () => {
    // REAL REGRESSION. The first version shared whatever the originator's `bscJson` returned, so a
    // failed read started by a `null`-fallback caller (useStreamProgress) handed `null` to an
    // `[]`-fallback caller (useProjectComplete), which did `.length` on it. The suite caught it as an
    // unhandled rejection. Sharing raw stdout and letting each caller apply its own fallback is what
    // makes the join safe between callers that disagree about what "nothing" means.
    const { spy, release } = stubPending(null);
    vi.spyOn(bscMod, "bsc").mockRejectedValue(new Error("bridge down"));
    const a = bscJsonShared<string[] | null>("p", ["plan", "list"], null, 0);
    const b = bscJsonShared<string[]>("p", ["plan", "list"], [], 0);
    release();
    expect(await a).toBeNull();
    expect(await b).toEqual([]);
    void spy;
  });

  it("an EMPTY read is each caller's own fallback too, not the originator's", async () => {
    stubRawOut("");
    const a = bscJsonShared<string[] | null>("p", ["plan", "list"], null, 0);
    const b = bscJsonShared<string[]>("p", ["plan", "list"], [], 0);
    expect(await a).toBeNull();
    expect(await b).toEqual([]);
  });

  it("a THROWN read leaves no entry behind to poison the next call", async () => {
    vi.spyOn(bscMod, "bsc").mockRejectedValueOnce(new Error("boom"));
    expect(await bscJsonShared("p", ["plan", "list"], ["fb"], 20_000)).toEqual(["fb"]);

    const spy = stubRead(["after"]);
    expect(await bscJsonShared("p", ["plan", "list"], [], 20_000)).toEqual(["after"]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("the measured case, end to end", () => {
  it("turns five pollers on one window into ONE spawn", async () => {
    // The shape from the log: five hooks, same read, overlapping 20s cadences.
    vi.useFakeTimers();
    const spy = stubRead([{ ref: "i1" }]);
    const HOOKS = 5;
    for (let tick = 0; tick < 3; tick++) {
      await Promise.all(
        Array.from({ length: HOOKS }, () =>
          bscJsonShared("proj", ["plan", "list", "--full", "--json"], [], 20_000),
        ),
      );
      vi.setSystemTime(Date.now() + 21_000);   // the next polling window
    }
    // Three windows × five hooks = fifteen spawns before; one per window now.
    expect(spy).toHaveBeenCalledTimes(3);
  });
});
