import { describe, it, expect } from "vitest";
import { closureOf, importedNames, importsFor, materialize, mergeById } from "./graph-rust-compile.mjs";

/**
 * The materialization convention is the load-bearing part of the Rust sweep, and getting it wrong does
 * not fail loudly — it reports the RECORDS as broken when the harness is. Measured: nesting each composed
 * record as its own submodule made 18 of 83 nodes "fail"; the flat convention plus primitive-derived
 * imports takes the same store to 83 of 83, with exactly one real defect found (`unquote.rs`).
 * These pin the convention so that inversion cannot come back silently.
 */

const rec = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  role: "algorithm",
  tech: "rust",
  code: "",
  ...extra,
});

const lookupOf = (...records: Array<Record<string, unknown>>) =>
  new Map(records.map((r) => [r.id as string, r]));

describe("closureOf", () => {
  it("walks composes transitively and keeps primitives OUT of the materialized set", () => {
    const lookup = lookupOf(
      rec("a.rs", { composes: ["b.rs", "rust.vec"] }),
      rec("b.rs", { composes: ["rust.hashmap"] }),
      { id: "rust.vec", role: "primitive", ref: "std::vec::Vec" },
      { id: "rust.hashmap", role: "primitive", ref: "std::collections::HashMap" },
    );
    const { algorithms, primitives } = closureOf("a.rs", lookup);
    expect(algorithms.map((a: { id: string }) => a.id).sort()).toEqual(["a.rs", "b.rs"]);
    expect(primitives.map((p: { id: string }) => p.id).sort()).toEqual(["rust.hashmap", "rust.vec"]);
  });

  it("terminates on a composes cycle rather than spinning", () => {
    const lookup = lookupOf(
      rec("a.rs", { composes: ["b.rs"] }),
      rec("b.rs", { composes: ["a.rs"] }),
    );
    expect(closureOf("a.rs", lookup).algorithms).toHaveLength(2);
  });

  it("ignores a composes entry that names a record the store does not have", () => {
    const lookup = lookupOf(rec("a.rs", { composes: ["ghost.rs"] }));
    expect(closureOf("a.rs", lookup).algorithms.map((a: { id: string }) => a.id)).toEqual(["a.rs"]);
  });
});

describe("importedNames", () => {
  it("reads the braced form, which is how the real records import collections", () => {
    expect([...importedNames("use std::collections::{HashMap, HashSet};")].sort()).toEqual([
      "HashMap",
      "HashSet",
    ]);
  });

  it("reads a plain single import", () => {
    expect([...importedNames("use std::collections::VecDeque;")]).toEqual(["VecDeque"]);
  });
});

describe("importsFor", () => {
  it("derives a `use` from each primitive's std path — the import IS on the node already", () => {
    const primitives = [{ id: "rust.hashmap", ref: "std::collections::HashMap" }];
    expect(importsFor(primitives)).toEqual(["use std::collections::HashMap;"]);
  });

  it("emits nothing for a language primitive, whose ref is not a path", () => {
    const primitives = [{ ref: "i64" }, { ref: "bool" }, { ref: "&[T]" }, { ref: "f64" }];
    expect(importsFor(primitives)).toEqual([]);
  });

  it("does NOT restate an import the code already has — that duplicate is E0252", () => {
    const primitives = [
      { ref: "std::collections::HashMap" },
      { ref: "std::collections::HashSet" },
    ];
    const already = importedNames("use std::collections::{HashMap, HashSet};");
    expect(importsFor(primitives, already)).toEqual([]);
  });
});

describe("materialize", () => {
  it("puts the closure in ONE FLAT SCOPE, because records call siblings by BARE NAME", () => {
    const lookup = lookupOf(
      rec("magnitude.rs", {
        composes: ["dot-product.rs"],
        code: "fn magnitude(v: &[f64]) -> f64 { dot_product(v, v).sqrt() }",
      }),
      rec("dot-product.rs", { code: "fn dot_product(a: &[f64], b: &[f64]) -> f64 { 0.0 }" }),
    );
    const out = materialize("magnitude.rs", lookup);
    expect(out).toContain("fn dot_product");
    expect(out).toContain("fn magnitude");
    // No submodule wrapper — nesting is what made the bare call unresolvable (E0425).
    expect(out).not.toMatch(/\bmod\s+dot_product\b/);
  });

  it("drops a qualified sibling import, which a flat scope makes unnecessary", () => {
    const lookup = lookupOf(
      rec("merge-sort.rs", {
        composes: ["merge.rs"],
        code: "use crate::merge::merge;\n\nfn merge_sort() { merge(); }",
      }),
      rec("merge.rs", { code: "fn merge() {}" }),
    );
    const out = materialize("merge-sort.rs", lookup);
    expect(out).not.toContain("use crate::merge::merge;");
    expect(out).toContain("fn merge_sort()");
  });

  it("supplies the import a primitive implies, so a node need not restate std paths", () => {
    const lookup = lookupOf(
      rec("word-frequencies.rs", {
        composes: ["rust.hashmap"],
        code: "fn word_frequencies() -> HashMap<String, u64> { HashMap::new() }",
      }),
      { id: "rust.hashmap", role: "primitive", ref: "std::collections::HashMap" },
    );
    expect(materialize("word-frequencies.rs", lookup)).toContain("use std::collections::HashMap;");
  });
});

// What the GATE sweeps. A guard that reads `~/.base-studio-code` cannot run in a fresh clone or in CI,
// and would report a machine's private state as a repo failure — so the gate reads the two COMMITTED
// stores instead. The repo store wins, because it is the one the build is meant to compile.
describe("gate sources", () => {
  it("merges by id with the later source winning", () => {
    const seed = [{ id: "a.rs", code: "seed" }, { id: "b.rs", code: "seed" }];
    const repo = [{ id: "a.rs", code: "repo" }];
    const { impls, byId } = mergeById(seed, repo);
    expect(impls).toHaveLength(2);
    expect(byId.get("a.rs")?.code, "the committed repo store is what the build compiles").toBe("repo");
    expect(byId.get("b.rs")?.code).toBe("seed");
  });

  it("tolerates an absent source, since a repo may have migrated nothing yet", () => {
    expect(mergeById(undefined, [{ id: "a.rs" }]).impls).toHaveLength(1);
    expect(mergeById().impls).toHaveLength(0);
  });

  it("ignores an entry with no id rather than keying on undefined", () => {
    expect(mergeById([{ code: "orphan" }, { id: "a.rs" }]).impls).toHaveLength(1);
  });
});
