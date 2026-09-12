// The pane RESOLVES the role gate and never latches a failed read
// (`toolsview-shows-triage-permissions-for-fifteen-of-nineteen-roles`).
//
// `ToolsView` cannot read the gate itself — a kit component's sandbox has no `bsc` bridge, which is why
// it vendored a wrong table for so long — so `PaneAt` reads `bsc session perms all` once and hands the
// capability down. Three properties of that wiring are load-bearing, and none of them is observable from
// the component's own tests:
//
//   1. ONE READ FOR EVERY PANE. `PaneAt` is memoized per pane and there can be many; a per-pane call is
//      the N+1 subprocess fan-out #3908 and #3954 were filed to undo.
//   2. NOTHING LATCHES ON A FAILED READ. `readRolePerms` resolves `null` when the read could not RUN.
//      Caching that would make one absent bridge permanent for the life of the app, so the memo drops
//      itself and the next pane to mount asks again.
//   3. THE PANE DOES NOT RE-DERIVE. It passes what the gate resolved, not a locally computed capability.
//
// ⚠️ WHY THIS ASSERTS OVER SOURCE INSTEAD OF BEHAVIOUR, which is the weaker instrument and is chosen
// only because the stronger one is unavailable. `PaneAt` is a RECORD whose imports include
// `@/components/console-pane-shell` and `@/components/console-states` — record-ID specifiers that ONLY
// the runtime graph loader resolves. Measured: neither record carries a `provides`, and
// `.bsc-records/components/` holds six unrelated files, so those specifiers resolve to nothing under
// vite/tsc/vitest and importing `PaneAt` in a test cannot work. The repo's own precedent for this
// situation is a source-asserting guard (`every_store_env_mutation_is_inside_the_store_lock` scans its
// crate's source for the same reason: nothing at run time can observe the ABSENCE of a lock).
//
// It reads the packaged seed — the same surface `recordBoundary.test.ts` and `pageRecordSpecifiers.test.ts`
// read, and what `bsc-emit` materializes the module from.
import { describe, it, expect } from "vitest";

const SEED = import.meta.glob<{ id?: string; srcText?: string }>("@data/components/app/**/*.json", {
  eager: true,
  import: "default",
});

const paneAt = Object.values(SEED).find((r) => r?.id === "console-pane-at");
/** Whitespace-normalized, so the assertions below are about CODE and not about line breaks. */
const src = (paneAt?.srcText ?? "").replace(/\s+/g, " ");

describe("the PaneAt perms wiring", () => {
  it("finds the record at all — a missing record would make every assertion below vacuous", () => {
    // NON-VACUITY. `find` returning undefined yields an empty string, which trivially fails to contain
    // a forbidden pattern and trivially passes a `not.toMatch` — the silent-green this repo keeps
    // getting caught by.
    expect(paneAt, "console-pane-at is not in the packaged seed").toBeTruthy();
    expect(src.length).toBeGreaterThan(2000);
    expect(src, "PaneAt no longer renders ToolsView — this guard is describing something else now")
      .toContain("<ToolsView");
  });

  it("reads the capability from Rust and hands it to the view", () => {
    expect(src).toContain("readRolePerms");
    expect(src).toMatch(/<ToolsView[^>]*cap=\{capabilityFor\(perms, paneRole\)\}/);
    expect(src).toMatch(/<ToolsView[^>]*capRead=\{permsRead\}/);
  });

  it("NOTHING LATCHES ON A FAILED READ — the memo drops itself when the read could not run", () => {
    // The property, stated as the code that implements it. Deleting this line is the whole bug: one
    // missing bridge at boot would otherwise pin every pane to "unreadable" for the app's lifetime.
    expect(src).toMatch(/if\s*\(\s*!\s*table\s*\)\s*permsOnce\s*=\s*null/);
  });

  it("asks ONCE for the whole table rather than once per pane", () => {
    // The read is behind a module-level memo, and the component body calls the memo — not the reader.
    expect(src).toMatch(/let permsOnce/);
    expect(src).toContain("rolePermsOnce()");
    const directCalls = [...src.matchAll(/readRolePerms\(/g)].length;
    expect(directCalls, "readRolePerms should be called in exactly one place — the memo").toBe(1);
  });

  it("does not re-derive the capability in the renderer", () => {
    // The maintainer's rule: the TypeScript is a shell that displays state from the crates. A local
    // derivation here would be the second opinion this slice removed from the component.
    expect(src).not.toContain("roleCapability(");
    expect(src).not.toContain("ROLE_DEFAULTS");
  });
});
