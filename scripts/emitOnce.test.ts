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
