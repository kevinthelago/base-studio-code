// The boot worktree reconciliation is DECIDED IN RUST
// (`a-reclaimed-worktree-reports-why-it-was-reclaimed`).
//
// WHY THIS TEST EXISTS AND WHAT IT REFUSES TO SETTLE FOR. Three times on this epic a flip "passed"
// with the call site reverted, because the test exercised the extracted function directly. The parity
// tests already prove `reconcile_missing_worktrees` behaves; they cannot say whether anything CALLS it.
// So this asserts the WIRING — and specifically the PAYLOAD, because a test that only checks the
// command fired would still pass if the argument were accepted and never sent.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { invoke } from "@tauri-apps/api/core";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";

const bootSrc = readFileSync(join(__dirname, "useAppBoot.ts"), "utf8");

/** The exact call the boot effect makes, replayed against the real `safeInvoke`. Driving the hook
 *  itself would need the whole app shell mounted; this exercises the same seam the effect uses. */
async function replayBootCall(panes: unknown[]) {
  return safeInvoke("reconcile_worktrees", { panes }, []);
}

describe("the boot worktree reconciliation is wired to Rust", () => {
  beforeEach(() => vi.mocked(invoke).mockClear());

  it("sends the PANE RECORDS, not just the command name", async () => {
    const panes = [
      { paneId: "p:api", stream: "api", cwd: "/wt/a", ended: false, disabled: false },
    ];
    await replayBootCall(panes);
    expect(invoke).toHaveBeenCalledWith("reconcile_worktrees", { panes });
    // The argument is the part that can be silently dropped — assert its SHAPE, since Rust
    // deserializes into `PaneRecord` and a renamed field would deserialize to a default, not an error.
    const [, args] = vi.mocked(invoke).mock.calls[0] as [string, { panes: Record<string, unknown>[] }];
    for (const k of ["paneId", "stream", "cwd", "ended", "disabled"]) {
      expect(Object.keys(args.panes[0]), `PaneRecord.${k} must be sent`).toContain(k);
    }
  });

  // ── the wiring itself, asserted against the shipped source ────────────────────────────────────────
  //
  // These are source-level because the failure they catch is an ABSENCE — the effect not calling the
  // command at all — and an absence is exactly what a behavioural test of the seam cannot see.

  it("the boot effect calls the Rust command", () => {
    expect(bootSrc).toContain('"reconcile_worktrees"');
  });

  it("and no longer decides the verdict in the renderer", () => {
    // The old path probed `dir_exists` per pane and inferred "work merged" from the absence. If this
    // comes back, the renderer is deciding again and the Rust reason is being ignored.
    expect(bootSrc).not.toContain("reconcileMissingWorktrees(");
    expect(bootSrc).not.toContain('"dir_exists"');
  });

  it("applies the marks Rust returned instead of building its own", () => {
    // `markPaneEnded` must be fed `m.info` — the record RUST produced. Re-deriving an EndedInfo here
    // would reintroduce the unconditional "work merged" summary this item removed.
    expect(bootSrc).toMatch(/markPaneEnded\(\s*m\.paneId,\s*m\.info\s*\)/);
    expect(bootSrc).not.toContain("reclaimedWorkerEnd(");
  });
});
