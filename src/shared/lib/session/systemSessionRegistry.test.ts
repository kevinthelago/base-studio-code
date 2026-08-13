// The closed set is the mitigation, and it is written down TWICE — once in Rust
// (`crates/bsc-session/src/lib.rs`, so the CLI can refuse a bad id without the app, and so the app can
// re-resolve one arriving over the channel) and once in TypeScript (`STUDIO_SESSIONS`, which owns the
// launch inputs). Two authorities is one more than ideal; this is the test that stops them drifting.
//
// WHY THE DRIFT IS WORTH A TEST OF ITS OWN. A diverged registry does not fail loudly. It shows up as a
// VALID id being refused — `bsc session start integrator` answering "not a system session" — which
// reads like a bug in the caller, not a bug in the table. Or worse in the other direction: an id Rust
// accepts and the app then rejects, stranding the round trip in the drift error nobody expects to see.
//
// This is the same shape as the Rust tests that read the frontend's wire fixtures by filename: one
// side reads the other's source rather than a third copy being introduced to compare against.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { STUDIO_SESSIONS, STUDIO_IDS } from "@/features/studio-sessions";

/** `crates/bsc-session/src/lib.rs`, resolved from this file rather than the cwd so it works from a
 *  worktree and from the repo root alike. */
const RUST_REGISTRY = resolve(__dirname, "../../../../crates/bsc-session/src/lib.rs");

/** Every `SystemSession { id: "...", pane_id: "...", … }` literal in the Rust table, in order. */
function rustRegistry(): { id: string; paneId: string }[] {
  const src = readFileSync(RUST_REGISTRY, "utf8");
  const table = src.slice(src.indexOf("pub const SYSTEM_SESSIONS"));
  const out: { id: string; paneId: string }[] = [];
  const re = /id:\s*"([^"]+)"\s*,\s*pane_id:\s*"([^"]+)"/g;
  for (let m = re.exec(table); m; m = re.exec(table)) out.push({ id: m[1], paneId: m[2] });
  return out;
}

describe("the system-session registry is the same closed set on both sides", () => {
  it("parses the Rust table at all", () => {
    // Guard the guard: a refactor that reshapes the Rust literal would silently make every assertion
    // below vacuous (an empty list matches an empty list), which is the failure mode a drift test can
    // least afford.
    expect(rustRegistry().length).toBeGreaterThan(0);
  });

  it("holds exactly the same ids, in the same order", () => {
    expect(rustRegistry().map((r) => r.id)).toEqual([...STUDIO_IDS]);
  });

  it("maps every id to the same pane id", () => {
    for (const { id, paneId } of rustRegistry()) {
      expect(STUDIO_SESSIONS[id as keyof typeof STUDIO_SESSIONS]?.paneId, `${id}'s pane id`).toBe(paneId);
    }
  });

  it("does not list a director, a worker, or any project pane", () => {
    // The property the whole grant rests on: `bsc session stop` cannot name a director because a
    // director is not IN the argument space. If one ever appeared here, the epic's settled asymmetry
    // would be silently undone.
    for (const { id, paneId } of rustRegistry()) {
      expect(id).not.toMatch(/director|worker|triage/i);
      expect(paneId).not.toMatch(/:director$|:triage$/);
    }
  });
});
