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
import { resolve } from "node:path";
// The MERGED store loader (`epic-retire-json-ledgers-for-db-and-git-drivers`) — the store is a file
// PLUS `graph/records/<id>.json` per record, and `bsc-session--lib.rs` may be in either.
import { loadStore } from "../../../../scripts/lib/recordStore.mjs";
import { STUDIO_SESSIONS, STUDIO_IDS } from "@/features/studio-sessions";

/** The committed graph store, resolved from this file rather than the cwd so it works from a worktree
 *  and from the repo root alike.
 *
 *  IT USED TO BE `crates/bsc-session/src/lib.rs` DIRECTLY. That file no longer exists
 *  (`the-crate-root-implementations-move-into-the-graph`): `bsc-session`'s crate root is the record
 *  `bsc-session--lib.rs`, and `crates/graph-materialize/build.rs` materializes it into `$OUT_DIR` at
 *  build time. So this still reads THE OTHER SIDE'S OWN SOURCE — the point of the test — it just
 *  reads it from where that source now lives. A `.rs` file materialized under `target/` would be a
 *  third copy and would be absent until something built the crate. */
const GRAPH_STORE = resolve(__dirname, "../../../../graph/algorithms.json");

/** The Rust crate root's source, out of the record that holds it. Keyed on `src` rather than on the
 *  record id, because `src` is the path this test used to open and is what says "the same file". */
function rustSource(): string {
  const store = loadStore(GRAPH_STORE) as {
    implementations: { src?: string; code?: string }[];
  };
  const rec = store.implementations.find((i) => i.src === "crates/bsc-session/src/lib.rs");
  return rec?.code ?? "";
}

/** Every `SystemSession { id: "...", pane_id: "...", … }` literal in the Rust table, in order. */
function rustRegistry(): { id: string; paneId: string }[] {
  const src = rustSource();
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
    // least afford. Reading a RECORD adds one more way to reach that state — a record id or `src` that
    // no longer resolves — so the source is asserted non-empty before it is parsed, and the two
    // failures read differently.
    expect(rustSource(), "no record in graph/algorithms.json has src crates/bsc-session/src/lib.rs").not.toBe("");
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
