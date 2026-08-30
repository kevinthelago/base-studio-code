import { describe, it, expect } from "vitest";
import { paneNeedsGate } from "@/app/console/lib/paneIdentity";

// THE SAME TABLE `every_fleet_identity_must_be_gated_and_a_manual_console_is_not` asserts in
// `src-tauri/src/console/pty/mod.rs`. Kept identical on purpose: the two predicates decide the same
// question on opposite sides of the bridge, and when they disagreed the result was a DEADLOCK —
// Rust refused a pane for a missing gate file while the frontend, thinking no gate was needed, never
// wrote one (`a-directors-pane-can-never-write-the-gate-that-lets-it-launch`). If either side's rule
// changes, both of these fail together, which is the point.
const GATED = [
  "studio-code:director",
  "studio-code:design-studio",
  "studio-code:kevinthelago/base-studio-code:triage",
];
const NOT_GATED = [
  "man:tab_abc:p2",  // the user's own console — they are the principal, so it warns, never refuses
  "t0p1",            // a legacy positional pane
  "pane",            // a bare id carries no project identity
];

describe("paneNeedsGate — the BACKEND's rule, asked on the frontend", () => {
  it("gates every fleet identity", () => {
    for (const id of GATED) expect(paneNeedsGate(id), id).toBe(true);
  });

  it("does not gate a manual console, a positional pane, or a bare id", () => {
    for (const id of NOT_GATED) expect(paneNeedsGate(id), id).toBe(false);
  });

  it("excludes `man:` explicitly — it is three colon-parts and would otherwise read as a worker", () => {
    // The exclusion is load-bearing, not cosmetic: without it a manual console would be REFUSED
    // rather than warned, which is the opposite of the intent (the user is the principal there).
    expect("man:tab_abc:p2".split(":").length).toBeGreaterThanOrEqual(2);
    expect(paneNeedsGate("man:tab_abc:p2")).toBe(false);
  });

  it("needs a non-empty project segment AND something after it", () => {
    expect(paneNeedsGate(":director")).toBe(false);   // no project
    expect(paneNeedsGate("studio-code:")).toBe(false); // nothing after it
    expect(paneNeedsGate("studio-code::")).toBe(false);
    expect(paneNeedsGate("studio-code:x")).toBe(true);
  });

  it("is total — never throws on an odd id", () => {
    for (const id of ["", ":", "::", "a:b:c:d"]) expect(() => paneNeedsGate(id)).not.toThrow();
  });
});
