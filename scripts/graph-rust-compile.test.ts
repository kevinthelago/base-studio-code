import { describe, it, expect } from "vitest";
import { closureOf, importedNames, importsFor, materialize, mergeById, materializedCrates, isMaterializedModule, MATERIALIZE_MARKER, MATERIALIZE_DEP, takesMaterializerAsBuildDependency } from "./graph-rust-compile.mjs";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** `crates/` of THIS repo, resolved from this test file so it works from any cwd. */
const CRATES = join(dirname(fileURLToPath(import.meta.url)), "..", "crates");

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

// Tier A vs Tier R. A crate that materializes its source carries WHOLE MODULES, compiled inside the
// crate against its dependencies — sweeping one as a standalone node is a category error that fails
// loudly and wrongly (`bsc-blueprint-cli.rs` cannot resolve `bsc_json_store` alone, and should not).
describe("materialized crates are Tier A, not Tier R", () => {
  const manifests: Record<string, string> = {
    "bsc-blueprint": `[package]
name = "bsc-blueprint"
${MATERIALIZE_MARKER}
`,
    "bsc-graph": `[package]
name = "bsc-graph"
`,
    // The OTHER opt-in route, verbatim in shape: a crate that already owns a build.rs cannot point
    // `build =` anywhere, so it takes the materializer as a build-dependency and CALLS it. `crates/data`
    // and `crates/bsc-config` are exactly this.
    data: `[package]
name = "bsc-data"

[build-dependencies]
${MATERIALIZE_DEP}
`,
  };

  it("reads the opt-in from each crate's OWN manifest, never a literal list", () => {
    const got = materializedCrates(["bsc-blueprint", "bsc-graph"], (d: string) => manifests[d] ?? null);
    expect([...got]).toEqual(["bsc-blueprint"]);
  });

  // REGRESSION, and it is the reason `MATERIALIZE_DEP` exists. Checking only the `build =` marker
  // dropped 20 healthy records out of the Tier-A exclusion the moment `crates/data` and
  // `crates/bsc-config` migrated — the sweep then built them standalone and reported 16 FAILED with
  // `unresolved import bsc_cli_util`, which is a whole crate module being asked to compile alone.
  it("counts a crate that CALLS the materializer from its own build.rs", () => {
    const got = materializedCrates(["bsc-blueprint", "bsc-graph", "data"], (d: string) => manifests[d] ?? null);
    expect([...got].sort()).toEqual(["bsc-blueprint", "data"]);
  });

  // The two routes are exclusive by construction — a package gets exactly ONE build script — so a
  // manifest carrying both is a mistake, not a shape to support. It still resolves to "materializes",
  // because the question this answers is whether the records are Tier A, and they are either way.
  it("is a single question, however the crate opted in", () => {
    const both = `[package]\nname = "x"\n${MATERIALIZE_MARKER}\n\n[build-dependencies]\n${MATERIALIZE_DEP}\n`;
    expect([...materializedCrates(["x"], () => both)]).toEqual(["x"]);
  });

  // THE SECTION IS PART OF THE QUESTION, and getting this wrong fails the OTHER way — quietly.
  // `crates/bsc-graph` takes the same package as a DEV-dependency (its tests drive the shipped
  // symbols) while its own source is not materialized. A whole-file `includes` read it as Tier A,
  // which would have excluded its records from this sweep entirely — and a record that is never swept
  // never reports anything at all.
  it("does NOT count the package as a dev- or ordinary dependency", () => {
    const dev = `[package]\nname = "x"\n\n[dev-dependencies]\n${MATERIALIZE_DEP}\n`;
    const plain = `[package]\nname = "x"\n\n[dependencies]\n${MATERIALIZE_DEP}\n`;
    expect([...materializedCrates(["x"], () => dev)]).toEqual([]);
    expect([...materializedCrates(["x"], () => plain)]).toEqual([]);
    expect(takesMaterializerAsBuildDependency(dev)).toBe(false);
    // …and the build-dependencies table ENDS at the next header rather than swallowing the file.
    const after = `[package]\nname = "x"\n\n[build-dependencies]\ntauri-build = "2"\n\n[dev-dependencies]\n${MATERIALIZE_DEP}\n`;
    expect(takesMaterializerAsBuildDependency(after)).toBe(false);
    // The PATH is not part of the question: src-tauri reaches the same package one level up.
    expect(
      takesMaterializerAsBuildDependency(
        '[build-dependencies]\ngraph-materialize = { path = "../crates/graph-materialize" }\n',
      ),
    ).toBe(true);
  });

  // THE REAL MANIFESTS, so the fixtures above cannot drift into describing a shape the repo stopped
  // using. Both routes must be represented, or one of them is untested against reality.
  it("finds both routes among the repo's own crates", () => {
    const dirs = readdirSync(CRATES, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    const read = (d: string) => {
      try {
        return readFileSync(join(CRATES, d, "Cargo.toml"), "utf8");
      } catch {
        return null;
      }
    };
    const got = materializedCrates(dirs, read);
    const shared = dirs.filter((d) => read(d)?.includes(MATERIALIZE_MARKER));
    const alongside = dirs.filter((d) => takesMaterializerAsBuildDependency(read(d) ?? ""));
    expect(shared.length).toBeGreaterThan(20);
    expect(alongside.sort()).toEqual(["bsc-config", "data"]);
    for (const d of [...shared, ...alongside]) expect(got.has(d)).toBe(true);
    // The one real crate that takes the materializer WITHOUT materializing — the reason the dependency
    // half is section-scoped. Named, so removing that dev-dependency says the case is gone rather than
    // quietly stopping to cover it.
    expect(read("bsc-graph")).toContain(MATERIALIZE_DEP);
    expect(got.has("bsc-graph")).toBe(false);
  });

  it("tolerates a crate with no readable manifest", () => {
    expect([...materializedCrates(["ghost"], () => null)]).toEqual([]);
  });

  it("excludes a record belonging to a materialized crate", () => {
    const crates = new Set(["bsc-blueprint"]);
    expect(isMaterializedModule("crates/bsc-blueprint/src/cli.rs", crates)).toBe(true);
    expect(isMaterializedModule("crates/cve/src/install.rs", crates)).toBe(false);
  });

  it("ignores a record with no src, or one outside crates/", () => {
    const crates = new Set(["bsc-blueprint"]);
    expect(isMaterializedModule(undefined, crates)).toBe(false);
    expect(isMaterializedModule("src/features/x.ts", crates)).toBe(false);
  });
});
