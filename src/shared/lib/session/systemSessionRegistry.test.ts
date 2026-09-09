// The closed set is the mitigation, and it is written down TWICE — once in Rust
// (`crates/bsc-session/src/lib.rs`, so the CLI can refuse a bad id without the app, and so the app can
// re-resolve one arriving over the channel) and once in TypeScript (`STUDIO_KINDS`, which owns the
// launch inputs). Two authorities is one more than ideal; this is the test that stops them drifting.
//
// WHY THE DRIFT IS WORTH A TEST OF ITS OWN. A diverged registry does not fail loudly. It shows up as a
// VALID id being refused — `bsc session start integrator` answering "not a system session" — which
// reads like a bug in the caller, not a bug in the table. Or worse in the other direction: an id Rust
// accepts and the app then rejects, stranding the round trip in the drift error nobody expects to see.
//
// WHAT IT PINS CHANGED WITH `the-studio-session-set-is-derived-not-declared`, and it now pins strictly
// more. Both sides used to hold the PRODUCT of studio kind and technology — eight rows — and this test
// compared the products. Both now hold the KINDS and derive the product from a technology axis read
// out of the stores, so the products are equal by construction wherever the kinds are; comparing the
// kinds is comparing the only thing that can actually diverge. And because the pane id of a derived
// session is `<prefix><tech>`, pinning the PREFIXES pins every pane id the projection will ever mint,
// including the ones for technologies that do not exist yet.
//
// This is the same shape as the Rust tests that read the frontend's wire fixtures by filename: one
// side reads the other's source rather than a third copy being introduced to compare against.
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
// The MERGED store loader (`epic-retire-json-ledgers-for-db-and-git-drivers`) — the store is a file
// PLUS `graph/records/<id>.json` per record, and `bsc-session--lib.rs` may be in either.
import { loadStore } from "../../../../scripts/lib/recordStore.mjs";
import { STUDIO_KINDS, studioIds, studioSessionsFor, studioSessionDef, studioAxis } from "@/features/studio-sessions";

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

interface RustKind {
  kind: string;
  /** The fixed pane id, for a studio with no technology axis. */
  paneId: string | null;
  /** The pane-id prefix a partitioned studio's technology is appended to. */
  panePrefix: string | null;
}

/** Every `StudioKind { kind: "...", pane_id: …, pane_prefix: …, … }` literal in the Rust table, in order. */
function rustKinds(): RustKind[] {
  const src = rustSource();
  const table = src.slice(src.indexOf("pub const STUDIO_KINDS"));
  const out: RustKind[] = [];
  const re =
    /kind:\s*"([^"]+)"\s*,\s*pane_id:\s*(?:None|Some\("([^"]+)"\))\s*,\s*pane_prefix:\s*(?:None|Some\("([^"]+)"\))/g;
  for (let m = re.exec(table); m; m = re.exec(table)) {
    out.push({ kind: m[1], paneId: m[2] ?? null, panePrefix: m[3] ?? null });
  }
  return out;
}

describe("the studio-kind registry is the same closed set on both sides", () => {
  it("parses the Rust table at all", () => {
    // Guard the guard: a refactor that reshapes the Rust literal would silently make every assertion
    // below vacuous (an empty list matches an empty list), which is the failure mode a drift test can
    // least afford. Reading a RECORD adds one more way to reach that state — a record id or `src` that
    // no longer resolves — so the source is asserted non-empty before it is parsed, and the two
    // failures read differently.
    expect(rustSource(), "no record in graph/algorithms.json has src crates/bsc-session/src/lib.rs").not.toBe("");
    expect(rustKinds().length).toBeGreaterThanOrEqual(5);
  });

  it("holds exactly the same kinds, in the same order", () => {
    expect(rustKinds().map((k) => k.kind)).toEqual(STUDIO_KINDS.map((k) => k.kind));
  });

  it("gives every kind the same pane id, or the same pane-id prefix", () => {
    // A PREFIX comparison is what makes this cover technologies that do not exist yet: every pane id
    // the projection can ever mint for a kind is that kind's prefix plus a validated technology, so
    // two agreeing prefixes is two agreeing infinite sets.
    for (const r of rustKinds()) {
      const ts = STUDIO_KINDS.find((k) => k.kind === r.kind);
      expect(ts, `${r.kind} is missing from the TypeScript kinds`).toBeTruthy();
      expect(ts!.paneId ?? null, `${r.kind}'s fixed pane id`).toBe(r.paneId);
      // The TS side carries a pane-id BUILDER rather than a prefix, so it is probed with a technology
      // whose spelling cannot be produced by any other means.
      const tsPrefix = ts!.paneIdFor ? ts!.paneIdFor("__t__").replace("__t__", "") : null;
      expect(tsPrefix, `${r.kind}'s pane-id prefix`).toBe(r.panePrefix);
    }
  });

  it("agrees that exactly two kinds are partitioned by technology", () => {
    // The asymmetry is the substance of the model — a kind either has an axis or it does not — so a
    // side that quietly gained or lost one would change which sessions exist without changing a
    // single id. Asserting the COUNT as well as the membership keeps this from going vacuous.
    const rustAxed = rustKinds().filter((k) => k.panePrefix !== null).map((k) => k.kind);
    const tsAxed = STUDIO_KINDS.filter((k) => k.axis !== null).map((k) => k.kind);
    expect(rustAxed).toEqual(tsAxed);
    expect(rustAxed).toEqual(["designer", "librarian"]);
  });

  it("does not list a director, a worker, or any project pane", () => {
    // The property the whole grant rests on: `bsc session stop` cannot name a director because a
    // director is not IN the argument space. If one ever appeared here, the epic's settled asymmetry
    // would be silently undone.
    for (const { kind, paneId, panePrefix } of rustKinds()) {
      expect(kind).not.toMatch(/director|worker|triage/i);
      expect(`${paneId ?? ""}${panePrefix ?? ""}`).not.toMatch(/:director|:triage/);
    }
  });
});

describe("the projection is the session set", () => {
  /** The technology axis as the stores actually hold it, MEASURED 2026-09-09: `impl.tech` over the
   *  committed record store is {rust: 1944, typescript: 79}, and `bsc ui kit list` reports react and
   *  react-native. There is no python record anywhere in this repo. */
  const MEASURED = studioAxis(["rust", "typescript"], ["react", "react-native"]);

  it("reproduces the declared table it replaced, minus the technology with no records", () => {
    // These seven pairs are the literals the old eight-row `STUDIO_SESSIONS` carried, copied from that
    // table rather than re-derived — so this asserts equality with the PREVIOUS behaviour rather than
    // with itself. A pane id is a resumable conversation: had any one of them changed, every existing
    // studio conversation would fork into a new one on the next start.
    expect(studioSessionsFor(MEASURED).map((d) => [d.id, d.paneId])).toEqual([
      ["designerReact", "design-studio:designer-react"],
      ["designerReactNative", "design-studio:designer-react-native"],
      ["librarianRust", "algorithms-studio:librarian-rust"],
      ["librarianTypescript", "algorithms-studio:librarian-typescript"],
      ["architect", "teams-studio:architect"],
      ["soundDesigner", "sound-studio:sound-designer"],
      ["integrator", "integration-studio:integrator"],
    ]);
    expect(studioIds(MEASURED)).not.toContain("librarianPython");
  });

  it("mints a studio the moment its technology has records, with no code change", () => {
    const withPython = studioAxis(["rust", "typescript", "python"], ["react", "react-native"]);
    const def = studioSessionsFor(withPython).find((d) => d.id === "librarianPython");
    expect(def?.paneId).toBe("algorithms-studio:librarian-python");
    expect(def?.role).toBe("librarian");
    expect(def?.tech).toBe("python");
    // The rosterName is what the mobile session list shows, and a technology with no display spelling
    // must still get a readable one rather than an empty suffix.
    expect(def?.rosterName).toBe("Algorithms Studio · Python");
  });

  it("parses an id the same way the Rust half does, capital for capital", () => {
    // THE ONE PLACE THE KIND COMPARISON ABOVE CANNOT REACH. Both halves turn `librarianRust` back into
    // `librarian` + `rust` with their own `kebab`, and two inverses that disagree mean an id one side
    // resolves and the other refuses — the exact silent drift this file exists to prevent, in the one
    // form comparing tables cannot show.
    //
    // The disagreement was real and was CONSECUTIVE CAPITALS: `/([a-z0-9])([A-Z])/` reads `AB` as `ab`
    // while the Rust loop reads it as `a-b`. No technology in the stores has them, so it was reachable
    // only by a hand-typed id — which is what this parse is the boundary for. The cases below are the
    // ones that separate the two rules; they are not illustrative.
    // `studioSessionDef` is the PARSE — the direction `kebab` is actually on. `studioSessionsFor`
    // builds ids from an axis and never calls it, so asserting through the projection would pass under
    // either rule and prove nothing.
    for (const [id, tech] of [
      ["librarianRust", "rust"],
      ["designerReactNative", "react-native"],
      ["librarianAB", "a-b"],
      ["librarianReactNNative", "react-n-native"],
    ] as const) {
      expect(studioSessionDef(id)?.tech, `${id} must parse back to ${tech}`).toBe(tech);
    }
  });

  it("drops a technology that cannot be a pane tail rather than minting a pane from it", () => {
    // A `tech` reaches this from a RECORD, which is data no type system checked. It becomes a pane key
    // and a directory name, so a separator or a space would reach somewhere it should not.
    const dirty = studioAxis(["rust", "../etc", "two words", "UPPER", ""], []);
    expect(dirty.librarian).toEqual(["rust"]);
    expect(studioIds(dirty)).toEqual(["librarian".concat("Rust"), "architect", "soundDesigner", "integrator"]);
  });
});
