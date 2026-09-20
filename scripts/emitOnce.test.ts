// The record tree is emitted ONCE per process, no matter how many plugin instances ask for it.
//
// `emitRecords` deletes the whole tree and rebuilds it. That is correct for one emitter and destructive
// for two: a WORKER is a separate rolldown build with its own plugin list, and its `buildStart` fires from
// inside the MAIN build's transform phase — so the second instance wiped the tree while modules were being
// loaded out of it. It failed as "Could not load .bsc-records/…", naming a DIFFERENT module each run, for
// files that were on disk by the time anyone checked.
//
// Lives under `scripts/` rather than `src/` because `vite/` is outside the tsconfig `include` and this
// test has to actually IMPORT the plugin — reading the file as text could not observe a shared guard.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const emitRecords = vi.hoisted(() => vi.fn());
vi.mock("../scripts/emit-records.mjs", () => ({ emitRecords }));

// A relative import, deliberately: `@/…` maps to `src/`, and this module is not under it.
const { bscRecords } = await import("../vite/bscRecords");

/** Call a plugin's `buildStart` the way vite does, without standing up a build. */
const start = (plugin: ReturnType<typeof bscRecords>) =>
  (plugin.buildStart as unknown as (this: unknown) => void).call({});

describe("bscRecords emission (#3604)", () => {
  // A BLOCK BODY, not `() => emitRecords.mockClear()`: that arrow RETURNS the mock, and vitest treats a function
  // returned from `beforeEach` as a cleanup and calls it after the test — which ran the previous test's mock
  // implementation against a root `afterEach` had already removed, and recreated it in /tmp.
  beforeEach(() => {
    emitRecords.mockClear();
  });

  it("emits at most once across INSTANCES — the root build and the worker sub-build share the guard", () => {
    const root = bscRecords({ repoRoot: process.cwd() });
    const worker = bscRecords({ repoRoot: process.cwd() });
    start(root);
    start(worker);
    start(root);
    // At most once: the module-level guard may already have been tripped by the vitest run's own
    // instance, which is the same guard doing the same job. What must never happen is a SECOND emit.
    expect(emitRecords.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("a fresh instance after the guard is tripped does not re-emit", () => {
    start(bscRecords({ repoRoot: process.cwd() }));
    emitRecords.mockClear();
    start(bscRecords({ repoRoot: process.cwd() }));
    expect(emitRecords).not.toHaveBeenCalled();
  });
});

// ── the mid-session self-heal (#a-long-running-dev-server-never-re-emits-a-newly-retired-record) ──
//
// Emission is once per PROCESS. A dev server then runs for hours while a fleet lands more retirements,
// so a card retired at 19:05 stayed unresolvable until someone restarted vite — reported twice, both
// times as `Failed to resolve import "@/features/settings/cards/…"`. A resolve that misses BOTH trees
// is the precise moment the tree is provably stale, so that is where the re-emit hangs.
describe("bscRecords re-emits a stale tree on a resolve miss", () => {
  // Its own reset: the suite above shares the module-level mock, so its calls would otherwise be
  // counted here.
  // A BLOCK BODY, not `() => emitRecords.mockReset()`: that arrow RETURNS the mock, and vitest treats a function
  // returned from `beforeEach` as a cleanup and calls it after the test — which ran the previous test's mock
  // implementation against a root `afterEach` had already removed, and recreated it in /tmp.
  beforeEach(() => {
    emitRecords.mockReset();
  });

  // Every root `repo()` makes is removed after each test, PASS OR FAIL
  // (`the-test-suites-still-leak-temp-entries-per-gate`). The trailing `rmSync` in a test body never runs
  // once an assertion above it throws, and a clean run still left a `bscrec-` root behind.
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  /** A throwaway repo root with the seed layout `newestInputMtime` reads. */
  const repo = () => {
    const root = mkdtempSync(join(tmpdir(), "bscrec-"));
    mkdirSync(join(root, "src-tauri", "data", "components"), { recursive: true });
    writeFileSync(join(root, "src-tauri", "data", "components", "seed.json"), "{}");
    roots.push(root);
    return root;
  };
  /** Call `resolveId` the way vite does. */
  const resolveId = (p: ReturnType<typeof bscRecords>, spec: string) =>
    (p.resolveId as unknown as (this: unknown, s: string) => string | null).call({}, spec);

  it("heals a miss when the seeds moved, then does not re-emit for the same seed state", () => {
    const root = repo();
    const plugin = bscRecords({ repoRoot: root });
    // Stand in for a successful emit: materialize the module the specifier names.
    emitRecords.mockImplementation(() => {
      mkdirSync(join(root, ".bsc-records", "features"), { recursive: true });
      writeFileSync(join(root, ".bsc-records", "features", "Retired.tsx"), "export default 1;\n");
    });

    // 1 · The record is not on disk yet — the miss re-emits and the RETRY finds it.
    const got = resolveId(plugin, "@/features/Retired");
    expect(emitRecords).toHaveBeenCalledTimes(1);
    expect(got).toBe(join(root, ".bsc-records", "features", "Retired.tsx"));

    // 2 · Same seed state, a specifier that still resolves to nothing: NO second emit. This is what
    // keeps the ~55 deliberately-unresolvable test fixtures (`@/components/a`, `@/gone/types`) from
    // charging a ~2.7s emit each.
    emitRecords.mockClear();
    expect(resolveId(plugin, "@/features/NeverExists")).toBeNull();
    expect(emitRecords).not.toHaveBeenCalled();

    // 3 · A seed actually changes — the guard re-arms, because this IS a new state.
    const seed = join(root, "src-tauri", "data", "components", "seed.json");
    const future = new Date(Date.now() + 60_000);
    utimesSync(seed, future, future);
    expect(resolveId(plugin, "@/features/StillMissing")).toBeNull();
    expect(emitRecords).toHaveBeenCalledTimes(1);

    rmSync(root, { recursive: true, force: true });
  });

  it("leaves a specifier that EXISTS under src/ alone — the plugin stays a no-op until a deletion", () => {
    const root = repo();
    mkdirSync(join(root, "src", "features"), { recursive: true });
    writeFileSync(join(root, "src", "features", "Live.tsx"), "export default 1;\n");
    emitRecords.mockClear();
    expect(resolveId(bscRecords({ repoRoot: root }), "@/features/Live")).toBeNull();
    expect(emitRecords).not.toHaveBeenCalled(); // a real file must never trigger an emit
    rmSync(root, { recursive: true, force: true });
  });
});

// ── the mid-session half `resolveId` structurally cannot reach (#an-edited-record-never-reaches-the-
//    running-dev-server) ──
//
// The re-emit above hangs off a resolve that misses BOTH trees — the moment a RETIREMENT becomes
// visible, because nothing can answer the specifier. An EDIT is the opposite shape: the first probe HITS
// and `resolveId` returns the stale file, so the staleness check below it is never reached; and an edit
// does not re-resolve anything in the first place, so no reordering inside that hook would help. Nothing
// else covered the gap either — `bsc components set` writes the LIVE STORE, `emitRecords` reads the PACKAGED
// SEED, and vite watches neither. A dev server therefore served a frozen copy of every record for its
// whole life, which is how a payload-tolerant `pty_data` listener written at 09:56 was still the 09:05
// version when the Rust half landed a minute later.
describe("bscRecords re-emits on a seed EDIT, with no resolve involved", () => {
  // A BLOCK BODY, not `() => emitRecords.mockReset()`: that arrow RETURNS the mock, and vitest treats a function
  // returned from `beforeEach` as a cleanup and calls it after the test — which ran the previous test's mock
  // implementation against a root `afterEach` had already removed, and recreated it in /tmp.
  beforeEach(() => {
    emitRecords.mockReset();
  });

  // Every root `repo()` makes is removed after each test, PASS OR FAIL
  // (`the-test-suites-still-leak-temp-entries-per-gate`). The trailing `rmSync` in a test body never runs
  // once an assertion above it throws, and a clean run still left a `bscrec-` root behind.
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  /** A throwaway repo root with the seed layout `newestInputMtime` reads. */
  const repo = () => {
    const root = mkdtempSync(join(tmpdir(), "bscrec-poll-"));
    mkdirSync(join(root, "src-tauri", "data", "components"), { recursive: true });
    writeFileSync(join(root, "src-tauri", "data", "components", "seed.json"), "{}");
    roots.push(root);
    return root;
  };

  /** A plugin on a FRESH copy of the module.
   *
   *  `emitted` and `emittedInputStamp` are module-level by design — one emit per PROCESS, across every
   *  plugin instance, is the guard the suite above pins. That makes them shared test state: a `buildStart`
   *  here is a no-op because an earlier suite already tripped the flag, so the stamp keeps a value from
   *  another temp root and the first poll fires against it. Re-importing gives this suite its own copy of
   *  that state without weakening the guard by exporting a reset. */
  const freshPlugin = async (root: string) => {
    vi.resetModules();
    const { bscRecords: fresh } = await import("../vite/bscRecords");
    return fresh({ repoRoot: root });
  };
  /** Call `configureServer` the way vite does, with the least server this plugin touches. `close()`
   *  fires the httpServer close handler, which is both the teardown this suite needs and the assertion
   *  that the plugin actually stops polling when the server goes away. */
  const configure = (p: ReturnType<typeof bscRecords>) => {
    const warn = vi.fn();
    let onClose = () => {};
    (p.configureServer as unknown as (this: unknown, s: unknown) => void).call({}, {
      config: { logger: { warn } },
      httpServer: { on: (ev: string, fn: () => void) => { if (ev === "close") onClose = fn; } },
    });
    return { warn, close: () => onClose() };
  };

  /** A seed mtime far enough ahead to beat the module-level stamp any earlier test left behind — the
   *  emitter's "have the seeds moved" state is per PROCESS, not per test. */
  const touchAhead = (seed: string, minutes: number) => {
    const at = new Date(Date.now() + minutes * 60_000);
    utimesSync(seed, at, at);
  };

  it("polls the seeds and re-emits when one is edited — the case a resolve never sees", async () => {
    vi.useFakeTimers();
    const root = repo();
    const plugin = await freshPlugin(root);
    const seed = join(root, "src-tauri", "data", "components", "seed.json");
    // Ahead of the stamp any earlier test left on the shared module, so "nothing changed" below is a
    // real observation rather than an accident of ordering.
    touchAhead(seed, 10);
    // `buildStart` owns the first emit and the stamp; the poll must stay out of its way until then.
    (plugin.buildStart as unknown as (this: unknown) => void).call({});
    const { close } = configure(plugin);
    emitRecords.mockClear();

    // 1 · Nothing changed: the poll costs a stat walk and emits nothing, however long it runs.
    vi.advanceTimersByTime(60_000);
    expect(emitRecords).not.toHaveBeenCalled();

    // 2 · A seed is EDITED — no import moves, nothing re-resolves, and the tree must still refresh.
    touchAhead(seed, 20);
    vi.advanceTimersByTime(2_000);
    expect(emitRecords).toHaveBeenCalledTimes(1);

    // 3 · …and exactly once for that one edit. A poll that re-emitted every tick would rewrite the tree
    //     every 2s, which is the churn this whole design exists to avoid.
    vi.advanceTimersByTime(60_000);
    expect(emitRecords).toHaveBeenCalledTimes(1);

    // 4 · The server going away stops the poll. Without this the interval outlives the dev server.
    close();
    touchAhead(seed, 30);
    vi.advanceTimersByTime(60_000);
    expect(emitRecords).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  it("a thrown emit warns and keeps the server alive", async () => {
    vi.useFakeTimers();
    const root = repo();
    const plugin = await freshPlugin(root);
    (plugin.buildStart as unknown as (this: unknown) => void).call({});
    const { warn, close } = configure(plugin);
    emitRecords.mockClear();
    // `…Once`, so the throwing implementation is gone the moment the tick has consumed it. Leaving it
    // installed makes the mock throw again out of vitest's own end-of-test cleanup, which surfaces as an
    // unhandled error and reds the test whose assertions all passed.
    emitRecords.mockImplementationOnce(() => {
      throw new Error("seed written mid-walk");
    });

    touchAhead(join(root, "src-tauri", "data", "components", "seed.json"), 40);
    // A throw inside the interval callback would otherwise take the dev server's process down.
    expect(() => vi.advanceTimersByTime(2_000)).not.toThrow();
    expect(emitRecords).toHaveBeenCalledTimes(1); // it really did reach the emitter, and survived
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("seed written mid-walk"));

    close();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });
});
