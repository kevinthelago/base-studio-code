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
import { describe, it, expect, vi, beforeEach } from "vitest";
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
  beforeEach(() => emitRecords.mockClear());

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
  beforeEach(() => emitRecords.mockReset());

  /** A throwaway repo root with the seed layout `newestInputMtime` reads. */
  const repo = () => {
    const root = mkdtempSync(join(tmpdir(), "bscrec-"));
    mkdirSync(join(root, "src-tauri", "data", "components"), { recursive: true });
    writeFileSync(join(root, "src-tauri", "data", "components", "seed.json"), "{}");
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
