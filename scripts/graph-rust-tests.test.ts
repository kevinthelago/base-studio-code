/**
 * `scripts/graph-rust-tests.mjs` — the Rust EDGE tier's two-copy invariant.
 *
 * The script itself is a gate leg over the REAL tree. These pin its rules against fixtures, so each
 * failure shape is observed failing rather than assumed to.
 */
import { describe, expect, it } from "vitest";
import { declaredTestTargets, rustTestEdges, violations, drifted, SHARED_TEST_ROOT, audit } from "./graph-rust-tests.mjs";

const manifest = (name: string, path = SHARED_TEST_ROOT) =>
  `[package]\nname = "x"\n\n[[test]]\nname = "${name}"\npath = "${path}"\n\n[dependencies]\nserde = "1"\n`;

const store = (src: string, bodies: string[] = ["#[test] fn t() {}"]) => ({
  edges: [{ id: "e--one", members: ["a.rs", "b.rs"], src, tests: bodies.map((s) => ({ src: s })) }],
});

describe("declaredTestTargets", () => {
  it("reads name and path out of the [[test]] tables and nothing else", () => {
    expect(declaredTestTargets(manifest("wire_contract"))).toEqual([
      { name: "wire_contract", path: SHARED_TEST_ROOT },
    ]);
  });

  it("does not mistake another table's keys for a target's", () => {
    // `[dependencies]` has a `path` too, and a scanner that kept reading past the header would take
    // it — reporting a target that does not exist, or a path that is not the shared root.
    const m = `[[test]]\nname = "a"\npath = "${SHARED_TEST_ROOT}"\n\n[dependencies]\nbsc-util = { path = "../bsc-util" }\n`;
    expect(declaredTestTargets(m)).toEqual([{ name: "a", path: SHARED_TEST_ROOT }]);
  });

  it("reads several targets in one manifest", () => {
    const m = `[[test]]\nname = "a"\npath = "p"\n\n[[test]]\nname = "b"\npath = "q"\n`;
    expect(declaredTestTargets(m).map((t) => t.name)).toEqual(["a", "b"]);
  });

  it("finds nothing in a manifest that declares nothing", () => {
    expect(declaredTestTargets(`[package]\nname = "x"\n`)).toEqual([]);
  });
});

describe("rustTestEdges", () => {
  it("takes an edge whose src names a cargo test target, and only that", () => {
    const s = {
      edges: [
        { id: "rust", src: "crates/c/tests/t.rs", tests: [{ src: "x" }] },
        // A FRONTEND edge — `bsc-emit` materializes this one; it is not a Rust test target.
        { id: "fe", src: "src/features/a/lib/b.test.ts", tests: [{ src: "x" }] },
        // A crate's `src/` is modules, and anything under `tests/<dir>/` is a module of a target.
        { id: "mod", src: "crates/c/src/m.rs", tests: [{ src: "x" }] },
        { id: "deep", src: "crates/c/tests/common/helpers.rs", tests: [{ src: "x" }] },
      ],
    };
    expect(rustTestEdges(s).map((e) => e.id)).toEqual(["rust"]);
    expect(rustTestEdges(s)[0]).toMatchObject({ crateDir: "c", name: "t" });
  });

  it("is empty for a store with no edges key at all", () => {
    expect(rustTestEdges({})).toEqual([]);
  });
});

describe("violations", () => {
  const run = (s: object, manifests: [string, string][], present: string[]) =>
    violations({
      edges: rustTestEdges(s),
      manifests: new Map(manifests),
      exists: (p: string) => present.includes(p),
    });

  it("passes an unmigrated edge — the file is on disk and cargo runs it", () => {
    expect(run(store("crates/c/tests/t.rs"), [], ["crates/c/tests/t.rs"])).toEqual([]);
  });

  it("passes a migrated edge whose crate declares the shared-root target", () => {
    expect(run(store("crates/c/tests/t.rs"), [["c", manifest("t")]], [])).toEqual([]);
  });

  // THE FAILURE THIS EXISTS FOR. Delete the file, forget the [[test]] entry, and the test simply is
  // not compiled any more — the suite reports all-passing with fewer tests in it.
  it("FAILS a migrated edge that no target reaches, and says how to fix it", () => {
    const bad = run(store("crates/c/tests/t.rs"), [], []);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain("RUNS");
    expect(bad[0]).toContain(SHARED_TEST_ROOT);
  });

  it("FAILS a file that came back while a target is still declared — two copies", () => {
    const bad = run(store("crates/c/tests/t.rs"), [["c", manifest("t")]], ["crates/c/tests/t.rs"]);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain("BACK on disk");
  });

  // `$OUT_DIR` is not cleaned between builds, so a stale generated file keeps an orphaned target
  // compiling against content the store no longer holds.
  it("FAILS a declared target with no edge behind it", () => {
    const bad = run({ edges: [] }, [["c", manifest("ghost")]], []);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain("no edge in the committed store");
  });

  it("ignores a [[test]] target that is an ordinary file, not a graph one", () => {
    expect(run({ edges: [] }, [["c", manifest("plain", "tests/plain.rs")]], [])).toEqual([]);
  });

  it("FAILS an edge carrying two bodies for one target", () => {
    const bad = run(store("crates/c/tests/t.rs", ["a", "b"]), [], ["crates/c/tests/t.rs"]);
    expect(bad[0]).toContain("2 test bodies");
  });
});

describe("drifted", () => {
  it("passes when the record and the file are byte-identical", () => {
    const edges = rustTestEdges(store("crates/c/tests/t.rs", ["#[test] fn t() {}"]));
    expect(drifted(edges, () => "#[test] fn t() {}")).toEqual([]);
  });

  // Found a REAL one on its first run: `bsc-lan-sense--two-documents-one-stream` still carried the
  // pre-roster `sensorPublicKey` API while the file had moved on — assertions that would not have
  // compiled against the crate they claim to test.
  it("FAILS on a single differing byte, because that is the only honest reading of 'the record IS that file'", () => {
    const edges = rustTestEdges(store("crates/c/tests/t.rs", ["#[test] fn t() {}"]));
    const bad = drifted(edges, () => "#[test] fn t() { }");
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain("DRIFTED");
  });

  it("says nothing about a migrated edge — `violations` owns that case", () => {
    const edges = rustTestEdges(store("crates/c/tests/t.rs"));
    expect(drifted(edges, () => null)).toEqual([]);
  });
});

describe("the real tree", () => {
  it("is green, and is checking something", () => {
    const r = audit(process.cwd());
    expect(r.lines).toEqual([]);
    // NON-VACUITY, asserted as a POPULATION so a matcher that stopped matching fails loudly instead
    // of going quiet. Both halves matter: edges exist, and at least one is executed from the graph.
    expect(r.checked).toBeGreaterThanOrEqual(6);
    expect(r.migrated).toBeGreaterThanOrEqual(1);
  });
});
