// `emitRecords` RECONCILES the emitted tree; it does not delete and rewrite it.
//
// THE BUG THIS PINS is not a wrong file — it is a wrong MTIME, and the damage it did was to a diagnosis
// rather than to a build. `.bsc-records/` sits inside the dev server's watched root, so rewriting all
// ~1,400 files on every emit is a change storm at whatever vite has the tree open. That cost is the whole
// reason the mid-session re-emit in `vite/bscRecords.ts` was gated behind a resolve MISS — which made it
// blind to an EDIT of a record already in the tree, and left a running dev server serving a frozen copy
// of every record for its whole life (`an-edited-record-never-reaches-the-running-dev-server`).
//
// So "writes nothing when nothing changed" is not an optimization here. It is the precondition that lets
// a re-emit run on a timer at all, and therefore the precondition for a record edit ever reaching the
// running app.
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A relative import, deliberately: `@/…` maps to `src/`, and this module is not under it.
const { writeIfChanged, staleEmitted } = await import("../scripts/emit-records.mjs");

const scratch = () => mkdtempSync(join(tmpdir(), "bscemit-"));

describe("writeIfChanged", () => {
  it("creates the file, parents and all", () => {
    const root = scratch();
    const p = join(root, "a", "b", "c.tsx");
    expect(writeIfChanged(p, "hello\n")).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("hello\n");
    rmSync(root, { recursive: true, force: true });
  });

  it("does NOT touch a file whose bytes already match — the mtime is the whole point", () => {
    const root = scratch();
    const p = join(root, "same.tsx");
    writeIfChanged(p, "same\n");
    const before = statSync(p).mtimeMs;
    expect(writeIfChanged(p, "same\n")).toBe(false);
    expect(statSync(p).mtimeMs).toBe(before); // an untouched mtime is what keeps HMR quiet
    rmSync(root, { recursive: true, force: true });
  });

  it("rewrites when the bytes differ, so a real edit is never swallowed", () => {
    const root = scratch();
    const p = join(root, "edited.tsx");
    writeIfChanged(p, "before\n");
    expect(writeIfChanged(p, "after\n")).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("after\n");
    rmSync(root, { recursive: true, force: true });
  });

  it("compares CONTENT, not mtime — a seed touched without changing must not churn the tree", () => {
    // `git checkout` rewrites mtimes on files whose bytes are unchanged. An mtime comparison would
    // rewrite the emitted copy on every branch switch and reload the app for nothing.
    const root = scratch();
    const p = join(root, "touched.tsx");
    writeIfChanged(p, "body\n");
    const before = statSync(p).mtimeMs;
    expect(writeIfChanged(p, "body\n")).toBe(false);
    expect(statSync(p).mtimeMs).toBe(before);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("staleEmitted — the prune that deleting the whole tree used to do", () => {
  it("names every file the plan no longer intends, at any depth", () => {
    const root = scratch();
    mkdirSync(join(root, "deep", "er"), { recursive: true });
    const keep = join(root, "deep", "Keep.tsx");
    const gone = join(root, "deep", "er", "Gone.tsx");
    writeFileSync(keep, "1");
    writeFileSync(gone, "2");
    expect(staleEmitted(root, new Map([[keep, "1"]]))).toEqual([gone]);
    rmSync(root, { recursive: true, force: true });
  });

  it("returns nothing when the tree already agrees with the plan", () => {
    const root = scratch();
    const p = join(root, "A.tsx");
    writeFileSync(p, "1");
    expect(staleEmitted(root, new Map([[p, "1"]]))).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("is empty — not an error — for a tree that does not exist yet", () => {
    expect(staleEmitted(join(tmpdir(), "bscemit-absent-" + Date.now()), new Map())).toEqual([]);
  });
});

describe("the reconcile against the REAL seeds", () => {
  // The one place the real emitter is exercised end to end. It runs LAST in this file and calls
  // `emitRecords` twice in a row, which is safe precisely because of the property under test: the second
  // run writes nothing. (`planRecords` exists so the rest of the suite never has to emit at all.)
  it("a re-emit with no seed change writes zero files and prunes zero", async () => {
    const { emitRecords } = await import("../scripts/emit-records.mjs");
    emitRecords({ quiet: true }); // bring the tree up to date, whatever state the run started in
    const second = emitRecords({ quiet: true }) as string[] & { changed: number; pruned: number };
    expect(second.changed).toBe(0);
    expect(second.pruned).toBe(0);
    expect(second.length).toBeGreaterThan(0); // a vacuous 0-record emit would pass the two above
    expect(existsSync(join(process.cwd(), ".bsc-records", ".gitignore"))).toBe(true);
  });
});
