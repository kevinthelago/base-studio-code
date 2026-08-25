//! `bsc graph` (#2761/#2853/#2961) — query AND curate the Algorithms knowledge library from a live
//! session. JSON out (compact by default; `--pretty` indents). The library is IMPL-ONLY (#2961): a node
//! IS its implementation — there is no abstract concept ontology. READ: `impl list` a language kit's
//! implementations, `dump` the whole store, `harvest`/`curate` a project's real code into candidates.
//! WRITE (#2853): `impl set`/`impl remove` curate the per-language kit tier (#2863) — implementations
//! carry a `role` (primitive | algorithm) and `compose` other same-tech impls. All persisted to the
//! on-disk store (`~/.base-studio-code/knowledge/algorithms.json`), so a read after a write reflects it.

use serde_json::Value;

/// The dispatcher's verb surface — MUST match the `match verb` arms in [`run`].
///
/// Exported so the packaged studio prose that TEACHES this CLI (the librarian spec,
/// `src-tauri/data/librarian/claude.md`) can be checked against the code rather than against a second
/// hand-written list (#3391). #2961 removed the concept ontology and its `list`/`neighbors`/`path`/
/// `link` verbs, but the spec kept teaching them and its test kept asserting them — spec and test
/// agreed with each other and both disagreed with the CLI. Deriving the expected surface from here
/// closes that loop: a verb renamed or removed drops out of this list, and the spec test fails on the
/// now-unknown verb its prose still names.
pub const VERBS: [&str; 17] = [
    "impl", "edge", "test", "harvest", "curate", "dump", "doctor", "refolder", "relink", "tests",
    "used-by", "merge", "emit", "promote", "build", "migrate-crate", "help",
];

/// The `impl` subverbs — MUST match the `match positional.get(1)` arms in [`run`].
///
/// `get` was missing until the librarian audit: the arm existed, `help` documented it, and the librarian
/// seed taught it to nobody — and because the spec drift test derives its expectations from THIS list,
/// the one verb the records architecture tells every worker to reach for was the one verb no test could
/// notice going undocumented. The list is only a drift guard if it is complete.
pub const IMPL_SUBVERBS: [&str; 8] =
    ["set", "get", "remove", "list", "suppress", "unsuppress", "history", "revert"];

/// The `edge` subverbs — MUST match the `match positional.get(1)` arms in [`run`].
pub const EDGE_SUBVERBS: [&str; 4] = ["set", "get", "list", "remove"];

/// The flags that take NO value. Needed by `reject_unknown_flags` to walk the argv correctly: a
/// value-taking flag consumes the next token, so `--summary "--x"` must not read as the flag `--x`.
pub const BOOL_FLAGS: [&str; 12] = [
    "--pretty", "--all", "--worthy-only", "--apply", "--fix", "--dry-run", "--no-src", "--run",
    "--check", "--wasm", "--force", "--seed",
];

/// Every flag [`run`] reads, across all verbs — MUST match the `flag_value` / `args.iter()` reads below.
pub const FLAGS: [&str; 44] = [
    "--pretty",
    // `promote` — the repo-store seam: `--check` is the gate (writes nothing, exits non-zero),
    // `--root` names the repo when the cwd is not it, `--seed` retargets the PACKAGED seed instead of
    // the build-readable repo store.
    "--check",
    "--root",
    "--seed",
    // `build` — compile a node and stamp the verdict; --wasm adds the wasm32 target, --force ignores
    // a current hash.
    "--wasm",
    "--force",
    // #71 — names WHAT replaced a suppressed algorithm, stored on the tombstone.
    "--superseded-by",
    // #72 — the revision `impl revert` restores to, and who to attribute the write to.
    "--to",
    "--by",
    // #72 — the WHY, recorded on the history entry alongside the who and the when.
    "--note",
    "--all",
    "--id",
    "--tech",
    "--role",
    "--name",
    "--summary",
    "--ref",
    "--code",
    // #76 — the same value, READ FROM DISK instead of pushed through argv.
    "--code-file",
    "--domain",
    "--clear",
    "--tags",
    "--kind",
    "--viz-code",
    "--viz-code-file",
    "--src",
    "--folder",
    "--provides",
    "--module-state",
    // How a materialized module is DECLARED — visibility and attributes ride on the record, because
    // a mod declaration carries meaning the body does not (a cfg gate, a private visibility).
    "--module-vis",
    "--module-attrs-file",
    "--reads",
    "--writes",
    "--module",
    "--composes",
    "--worthy-only",
    "--apply",
    "--fix",
    // #78 — the dedup pass over the impl set, a focused mode of `doctor`.
    "--dedup",
    "--dry-run",
    "--no-src",
    "--members",
    "--out",
    "--run",
];

/// Materialize ONE record into `out` and, when `run`, execute its paired tests there.
///
/// Shared by `test <id>` and `test --all` so there is a single answer to "what does a record's
/// filesystem contain" — two materializers would drift the moment one learned something.
fn single_record_test(id: &str, out: &str, run: bool, g: &Value) -> Result<Value, String> {

            let id = &id;
            let out = out.to_string();
                        let im = crate::implementations_of(g)
                .into_iter()
                .find(|x| x.get("id").and_then(Value::as_str) == Some(*id))
                .ok_or_else(|| format!("no implementation '{id}'"))?;
            // The runner is chosen by the record's OWN `tech`, never guessed from the id. Everything
            // below this point is the TypeScript materializer, and handing it a Rust node wrote Rust
            // source into a `.ts` file — which is why no Rust record had ever been compiled.
            match im.get("tech").and_then(Value::as_str) {
                Some("rust") => return rust_record_test(id, &out, run, &im, g),
                // An unsupported tech is REFUSED by name. Falling through to vitest is how a Rust node
                // came to be "tested" by a TypeScript runner in the first place.
                Some(t) if t != "typescript" => {
                    return Err(format!(
                        "`bsc graph test` has no runner for tech `{t}` — supported: typescript, rust"
                    ))
                }
                _ => {}
            }

            let tests = im.get("tests").and_then(Value::as_array).cloned().unwrap_or_default();
            if tests.is_empty() {
                // A vacuous pass is worse than a refusal: it would report "green" for a record nothing
                // checks, which is exactly the reading this whole tier exists to make impossible.
                return Err(format!(
                    "'{id}' has no paired test — nothing to run. An integration test lives on an edge                      (`bsc graph edge list`), not on the record."
                ));
            }
            let code = im.get("code").and_then(Value::as_str).unwrap_or_default();
            // The module's ORIGINAL basename, not the record id: the paired test imports it the way it
            // always did (`./usePlanGates`), and `use-plan-gates` would not resolve.
            let stem = im
                .get("src")
                .and_then(Value::as_str)
                .and_then(|p| p.rsplit('/').next())
                .map(|f| f.trim_end_matches(".tsx").trim_end_matches(".ts").to_string())
                .unwrap_or_else(|| id.to_string());
            let dir = std::path::Path::new(&out);
            std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {out}: {e}"))?;
            let module_file = dir.join(format!("{stem}.ts"));
            std::fs::write(&module_file, code).map_err(|e| format!("cannot write the module: {e}"))?;
            let mut written = vec![module_file.to_string_lossy().into_owned()];
            for (i, t) in tests.iter().enumerate() {
                let src = t.get("src").and_then(Value::as_str).unwrap_or_default();
                let name = if i == 0 { format!("{stem}.test.ts") } else { format!("{stem}.{i}.test.ts") };
                let p = dir.join(&name);
                std::fs::write(&p, src).map_err(|e| format!("cannot write {name}: {e}"))?;
                written.push(p.to_string_lossy().into_owned());
            }
            // The record's filesystem declares HOW it is tested. Without a config here, vitest walks UP
            // and finds the repo's — which pulls in `src/test/setup.ts` and every alias, so the run would
            // silently borrow the very context isolation is meant to withhold. (It fails loudly:
            // "Cannot find module .../src/test/setup.ts".)
            //
            // `environment` follows the test itself: a record that renders needs a DOM, one that computes
            // does not, and forcing jsdom on every record would make the run slower and less honest about
            // what the record actually requires.
            let needs_dom = tests.iter().any(|t| {
                t.get("src").and_then(Value::as_str).is_some_and(|src| src.contains("@testing-library"))
            });
            let env = if needs_dom { "jsdom" } else { "node" };
            std::fs::write(
                dir.join("vitest.config.ts"),
                format!(
                    "// Generated by `bsc graph test` — the record's own test contract.
                     // Present so vitest does NOT walk up and load the repo's config, which would lend
                     // this record the aliases and setup file that isolation exists to withhold.
                     import {{ defineConfig }} from \"vitest/config\";
                     export default defineConfig({{ test: {{ environment: \"{env}\", include: [\"*.test.ts\"] }} }});
"
                ),
            )
            .map_err(|e| format!("cannot write the test config: {e}"))?;
            written.push(dir.join("vitest.config.ts").to_string_lossy().into_owned());

            let mut result = serde_json::json!({
                "id": id, "dir": out, "written": written, "tests": tests.len(), "environment": env, "ran": false,
            });
            if run {
                // `npx vitest run` in the materialized dir. The dir has no config and no node_modules of
                // its own, so resolution walks UP — which is why the directory's location is the whole
                // isolation story, and why the sealed distro is the eventual home.
                // `.cmd` on Windows: `Command` resolves an exact filename and does not consult PATHEXT,
                // so a bare "npx" is simply "program not found" there.
                let npx = if cfg!(windows) { "npx.cmd" } else { "npx" };
                // `--root .` with no config in the directory is the ISOLATION: package imports resolve
                // (node walks up to a node_modules), while `@/…` app imports do NOT, because the alias
                // lives in the repo's vitest config and this run never loads it. A record whose test
                // reached sideways therefore FAILS here rather than passing on borrowed context — which
                // is the same contract the sealed image gives, reached by config absence instead of a
                // filesystem seal.
                let output = std::process::Command::new(npx)
                    .args(["vitest", "run", "--root", "."])
                    .current_dir(dir)
                    .output()
                    .map_err(|e| format!("cannot run vitest: {e}"))?;
                let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
                let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
                result["ran"] = Value::Bool(true);
                result["passed"] = Value::Bool(output.status.success());
                result["output"] = Value::String(if stdout.trim().is_empty() { stderr } else { stdout });
            }
            Ok(result)
        }

/// Materialize ONE Rust record into `out` as a standalone crate and, when `run`, compile it there.
///
/// The convention lives in [`crate::rust_test`] — flat closure, primitive-derived imports — and is
/// documented there rather than here, because getting it wrong reports the RECORDS as broken.
///
/// Two deliberate differences from the TypeScript path:
///
/// * A record with no paired test is NOT refused. For Rust a compile is itself a verdict — it is what
///   catches a unicode escape in a byte literal — so a testless node is compiled and reported as
///   compiled. Only 18 of this store's 96 Rust nodes carry a test at all.
/// * A paired test is the whole harvested FILE (Rust tests live inline), so its `#[cfg(test)]` modules
///   are extracted and the surrounding module is left behind. Every skip is reported: a skip nobody is
///   told about is how a caller comes to believe a record was checked when it was not.
fn rust_record_test(id: &str, out: &str, run: bool, im: &Value, g: &Value) -> Result<Value, String> {
    let impls = crate::implementations_of(g);
    let refs: Vec<&Value> = impls.iter().collect();
    let closure = crate::rust_test::closure_of(&refs, id);

    let raw_tests = im.get("tests").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut test_modules = Vec::new();
    let mut skipped_tests = Vec::new();
    for t in &raw_tests {
        let src = t.get("src").and_then(Value::as_str).unwrap_or_default();
        let found = crate::rust_test::extract_test_modules(src);
        if found.is_empty() {
            skipped_tests.push(serde_json::json!({
                "name": t.get("name").and_then(Value::as_str).unwrap_or("<unnamed>"),
                "reason": "no `#[cfg(test)]` module in the paired source — nothing to extract",
            }));
        } else {
            test_modules.extend(found);
        }
    }

    let name = crate::rust_test::crate_name(id);
    let dir = std::path::Path::new(out);
    let src_dir = dir.join("src");
    std::fs::create_dir_all(&src_dir).map_err(|e| format!("cannot create {out}: {e}"))?;

    let manifest = dir.join("Cargo.toml");
    std::fs::write(&manifest, crate::rust_test::cargo_toml(&name))
        .map_err(|e| format!("cannot write the manifest: {e}"))?;
    let lib = src_dir.join("lib.rs");
    std::fs::write(&lib, crate::rust_test::materialize(&closure, &test_modules))
        .map_err(|e| format!("cannot write the module: {e}"))?;

    let written = vec![
        manifest.to_string_lossy().into_owned(),
        lib.to_string_lossy().into_owned(),
    ];
    let mut result = serde_json::json!({
        "id": id, "dir": out, "written": written, "tech": "rust",
        "closure": closure.algorithms.iter().filter_map(|r| r.get("id").and_then(Value::as_str)).collect::<Vec<_>>(),
        "tests": test_modules.len(), "skippedTests": skipped_tests, "ran": false,
    });
    if run {
        // `cargo test` compiles AND runs; with no test module it still compiles, which is the verdict
        // that matters here. The crate has its own manifest and its own target dir, so it never joins
        // the workspace — a record that reached for a workspace crate fails here, as it should.
        let verb = if test_modules.is_empty() { "build" } else { "test" };
        let output = std::process::Command::new("cargo")
            .args([verb, "--quiet"])
            .current_dir(dir)
            .env("CARGO_TARGET_DIR", dir.join("target"))
            // The repo sets sccache as `rustc-wrapper`; a materialized crate must not depend on the
            // developer having it installed, or an isolated run fails for a reason unrelated to the record.
            .env_remove("RUSTC_WRAPPER")
            .output()
            .map_err(|e| format!("cannot run cargo: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        result["ran"] = Value::Bool(true);
        result["verb"] = Value::String(verb.to_string());
        result["passed"] = Value::Bool(output.status.success());
        result["output"] = Value::String(if stdout.trim().is_empty() { stderr } else { stdout });
    }
    Ok(result)
}

/// Crate directories whose source is materialized from the graph, read from each crate's OWN manifest.
///
/// Derived, never a literal list, so it cannot drift from reality. Resolved relative to the CURRENT
/// DIRECTORY: `bsc graph build` is a repo-root command. Outside a repo the set is empty, which means a
/// Tier-A record would be built and would fail loudly — visible, rather than silently mis-skipped.
fn materialized_crates() -> Vec<String> {
    let Ok(cwd) = std::env::current_dir() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(cwd.join("crates")) else { return Vec::new() };
    entries
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .filter(|e| {
            std::fs::read_to_string(e.path().join("Cargo.toml"))
                .is_ok_and(|t| t.contains(crate::build_facet::MATERIALIZE_MARKER))
        })
        .filter_map(|e| e.file_name().into_string().ok())
        .collect()
}

/// The compiler's own identity — part of the build hash, because the same source compiles or does not
/// depending on it. Unknown rather than a panic: a machine without rustc can still READ the store.
fn rustc_version() -> String {
    std::process::Command::new("rustc")
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "unknown-rustc".into())
}

/// Where compiled artifacts live — a content-addressed sidecar, never inline in the 8.74 MB store.
fn artifacts_dir() -> Option<std::path::PathBuf> {
    bsc_util::bsc_base_dir().map(|b| b.join("knowledge").join("artifacts"))
}

/// Does every artifact this node's facet names still exist?
///
/// The sidecar is a cache — it can be swept, or absent in a fresh clone. A hash match with a missing
/// artifact must REBUILD, not report cached, or the node claims an output nothing can load.
fn artifacts_present(node: &Value) -> bool {
    let Some(dir) = artifacts_dir() else { return false };
    let Some(targets) = node.get("build").and_then(|b| b.get("targets")).and_then(Value::as_object) else {
        return true; // nothing claimed, nothing missing
    };
    targets.values().all(|t| match t.get("artifact").and_then(Value::as_str) {
        Some(sha) => dir.join(crate::build_facet::artifact_name(sha, "wasm")).is_file(),
        None => true,
    })
}

/// Compile one materialized node, natively and (optionally) to wasm.
fn build_one(
    id: &str,
    source: &str,
    want_wasm: bool,
    hash: &str,
) -> Result<Vec<crate::build_facet::TargetOutcome>, String> {
    use crate::build_facet::TargetOutcome;
    let work = std::env::temp_dir().join(format!("bsc-graph-build-{}", crate::rust_test::crate_name(id)));
    std::fs::create_dir_all(&work).map_err(|e| format!("cannot create {}: {e}", work.display()))?;
    let src = work.join(format!("{}.rs", crate::rust_test::crate_name(id)));
    std::fs::write(&src, source).map_err(|e| format!("cannot write the module: {e}"))?;

    let mut out = Vec::new();

    let native = std::process::Command::new("rustc")
        .args(["--edition", "2021", "--crate-type", "lib", "--out-dir"])
        .arg(&work)
        .arg(&src)
        .output()
        .map_err(|e| format!("cannot run rustc: {e}"))?;
    out.push(if native.status.success() {
        TargetOutcome::pass("native")
    } else {
        TargetOutcome::fail("native", first_error(&String::from_utf8_lossy(&native.stderr)))
    });

    if want_wasm {
        // A cdylib with no `#[no_mangle] extern "C"` export produces a module that LOADS but exposes
        // nothing. That is honest for this slice: it proves the node reaches wasm and gives a real byte
        // size. The export contract — what the animation actually calls — belongs to
        // `one-implementation-drives-the-animation`, and is not invented here.
        let wasm_out = work.join("wasm");
        std::fs::create_dir_all(&wasm_out).map_err(|e| format!("cannot create {}: {e}", wasm_out.display()))?;
        let mut cmd = std::process::Command::new("rustc");
        cmd.args(["--edition", "2021", "--target", "wasm32-unknown-unknown", "--crate-type", "cdylib"])
            .args(crate::build_facet::WASM_FLAGS)
            .arg("--out-dir")
            .arg(&wasm_out)
            .arg(&src);
        let w = cmd.output().map_err(|e| format!("cannot run rustc for wasm32: {e}"))?;
        if !w.status.success() {
            out.push(TargetOutcome::fail("wasm32", first_error(&String::from_utf8_lossy(&w.stderr))));
        } else {
            let produced = std::fs::read_dir(&wasm_out)
                .map_err(|e| format!("cannot read {}: {e}", wasm_out.display()))?
                .filter_map(Result::ok)
                .map(|e| e.path())
                .find(|p| p.extension().and_then(|s| s.to_str()) == Some("wasm"));
            match produced {
                None => out.push(TargetOutcome::fail("wasm32", "rustc reported success but emitted no .wasm")),
                Some(p) => {
                    let bytes = std::fs::read(&p).map_err(|e| format!("cannot read {}: {e}", p.display()))?;
                    // Content-addressed by the ARTIFACT, not by the build hash: two nodes that compile
                    // to identical bytes share one file, which is the point of a content-addressed store.
                    let sha = bsc_cli_util::vendored::sha256_hex(&bytes);
                    if let Some(dir) = artifacts_dir() {
                        std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
                        std::fs::write(dir.join(crate::build_facet::artifact_name(&sha, "wasm")), &bytes)
                            .map_err(|e| format!("cannot write the artifact: {e}"))?;
                    }
                    let exports = crate::build_facet::wasm_export_count(&bytes).unwrap_or(0);
                    out.push(
                        TargetOutcome::pass("wasm32")
                            .with_artifact(sha, bytes.len() as u64)
                            .with_exports(exports),
                    );
                }
            }
        }
    }
    let _ = hash;
    Ok(out)
}

/// The first real error line from a rustc run — enough to act on, without pasting a screen of context.
fn first_error(stderr: &str) -> String {
    stderr
        .lines()
        .find(|l| l.starts_with("error"))
        .unwrap_or("rustc failed with no error line")
        .to_string()
}

/// Write the facet onto the node IN PLACE, leaving every other field untouched.
fn stamp_build(g: &mut Value, id: &str, facet: Value) {
    if let Some(arr) = g.get_mut("implementations").and_then(Value::as_array_mut) {
        for i in arr.iter_mut() {
            if i.get("id").and_then(Value::as_str) == Some(id) {
                if let Some(o) = i.as_object_mut() {
                    o.insert("build".into(), facet);
                }
                return;
            }
        }
    }
}

/// Every entity id in the GLOBAL data graph, for the surface-restriction check
/// (the-data-graph-a-global-third-pillar). Best-effort: an unreadable or absent store yields an EMPTY
/// list, which SKIPS the check rather than condemning every declaration — a machine that has never
/// written an entity must not be told all of its nodes are wrong.
fn entity_ids() -> Vec<String> {
    bsc_data::entity::open(None)
        .map(|s| bsc_data::entity::list(&s).into_iter().map(|e| e.id).collect())
        .unwrap_or_default()
}

/// Token 5-grams of a body, hashed — the shape used to tell "the same implementation twice" from
/// "two implementations that happen to share words".
///
/// Tokenizing first is what makes it robust to the only difference the real duplicates actually had:
/// `llm-energy.ts` and `algorithms-llm-energy.ts` differ by 21 characters of formatting and wrapper,
/// so their raw `code` is NOT equal — yet their shingle sets are IDENTICAL. A byte comparison misses
/// the exact pair this was requested for.
fn code_shingles(code: &str) -> std::collections::HashSet<u64> {
    let mut tokens: Vec<&str> = Vec::new();
    let bytes = code.as_bytes();
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'$';
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b.is_ascii_whitespace() {
            i += 1;
        } else if word(b) {
            let start = i;
            while i < bytes.len() && word(bytes[i]) {
                i += 1;
            }
            tokens.push(&code[start..i]);
        } else {
            // Every other byte is its own token, so punctuation-heavy code still shingles. Stepping by
            // the CHAR width keeps a multi-byte character from being split into invalid slices.
            let w = code[i..].chars().next().map_or(1, char::len_utf8);
            tokens.push(&code[i..i + w]);
            i += w;
        }
    }
    const N: usize = 5;
    tokens
        .windows(N)
        .map(|w| {
            // FNV-1a over the window — a set of hashes is far cheaper to intersect than a set of
            // string tuples, and a collision only ever costs a slightly higher score.
            let mut h: u64 = 0xcbf2_9ce4_8422_2325;
            for t in w {
                for b in t.as_bytes() {
                    h ^= u64::from(*b);
                    h = h.wrapping_mul(0x1000_0000_01b3);
                }
                h ^= 0xff;
                h = h.wrapping_mul(0x1000_0000_01b3);
            }
            h
        })
        .collect()
}

/// A body shorter than this carries no evidence. `export const x = 1;` repeated across records is a
/// language, not a duplicate — and at four or five tokens any two such lines score 1.0.
const MIN_SHINGLES: usize = 8;

/// Shingle overlap at or above which two bodies are the SAME implementation. Measured on the real
/// store: the two known duplicate pairs score **1.00**, while 400 random pairs have a median of
/// 0.0008 and a maximum of **0.037**. There is no distribution between those, so the threshold is a
/// chasm rather than a tuned knob.
const NEAR_DUPLICATE: f64 = 0.8;

/// Minimum share of a group's possible pairs that must be observed for it to report as one cluster —
/// the anti-chaining guard, matching the component-side detector (#74). `A~B` and `B~C` with `A` and
/// `C` unrelated is a chain, and collapsing it asserts a similarity no member exhibits.
const CLUSTER_DENSITY: f64 = 0.5;

/// Duplicate-candidate GROUPS over the impl set — the algorithms-graph dedup pass (#78).
///
/// The library had no duplicate detection at all, so a session hunting duplicates built ad-hoc grep
/// regexes against the raw `impl list` dump and found ~30 by hand — `llm-energy.ts` /
/// `algorithms-llm-energy.ts`, `layer-dag.ts` / `layers.ts`, `tab-index-map.ts` / `tab-reorder.ts`,
/// and a tail from a second module-level harvest that re-added function-level nodes already stored.
///
/// TWO SIGNALS, AND NEITHER IS THE ONE THE REQUEST NAMED — because both of those were measured first
/// and both are noise at this scale:
///
/// * **a shared `name`** puts 24 records in one group (`graphPlatform`), 20 in another (`index`), 10
///   in another (`store`). Those are naming conventions, not duplication.
/// * **a shared `src`** puts 10 records in one group, because harvest at FUNCTION granularity lifts
///   many functions out of one file — `dayKey`, `fmtBytes`, `fmtClock` all legitimately carry
///   `shared/lib/core/format.ts`.
///
/// Implemented literally, those two produced **110 groups over 356 impls** against a store the
/// reporter had already cleaned to ~2 real duplicates: the #74 failure this request is the twin of,
/// rebuilt. What actually separates a duplicate is the BODY, plus name-and-src together as a
/// corroborated pair. See [`NEAR_DUPLICATE`] for the measurement.
///
/// GROUPS, NOT PAIRS — N duplicates report as ONE row naming every member, and groups sharing the
/// same members merge, carrying every signal. Three signals over one pair is still one fact.
///
/// PROPOSE-ONLY. `bsc graph merge` is the verb that acts and it repoints every consumer; which record
/// survives is not a decision a diagnostic gets to make.
fn dedup_findings(g: &Value) -> Vec<Value> {
    let text = |im: &Value, k: &str| im.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
    // A RETIRED id is not a duplicate candidate — it is already folded away, and proposing a merge for
    // it would send the reader to redo one that already happened (#77).
    let impls: Vec<Value> = crate::implementations_of(g)
        .into_iter()
        .filter(|im| im.get("id").and_then(Value::as_str).is_some_and(|id| !crate::is_suppressed(g, id)))
        .collect();

    // ── signal 1: the same body ──
    let bodies: Vec<(String, std::collections::HashSet<u64>)> = impls
        .iter()
        .filter_map(|im| {
            let id = text(im, "id");
            let code = text(im, "code");
            if id.is_empty() || code.is_empty() {
                return None;
            }
            let sh = code_shingles(&code);
            (sh.len() >= MIN_SHINGLES).then_some((id, sh))
        })
        .collect();
    let mut pairs: Vec<(&str, &str)> = Vec::new();
    for (a, (id_a, sh_a)) in bodies.iter().enumerate() {
        for (id_b, sh_b) in bodies.iter().skip(a + 1) {
            // Cheap reject first: bodies of wildly different size cannot clear the bar, and this keeps
            // the all-pairs sweep affordable at a thousand records.
            if sh_a.len() * 2 < sh_b.len() || sh_b.len() * 2 < sh_a.len() {
                continue;
            }
            let inter = sh_a.intersection(sh_b).count();
            if inter == 0 {
                continue;
            }
            let union = sh_a.len() + sh_b.len() - inter;
            if union > 0 && (inter as f64) / (union as f64) >= NEAR_DUPLICATE {
                pairs.push((id_a.as_str(), id_b.as_str()));
            }
        }
    }

    // (signal, key) → the ids sharing it. Body pairs are clustered below; this holds the exact signal.
    let mut buckets: std::collections::BTreeMap<(&'static str, String), std::collections::BTreeSet<String>> =
        std::collections::BTreeMap::new();
    for im in &impls {
        let (id, name, src) = (text(im, "id"), text(im, "name"), text(im, "src"));
        // ── signal 2: the same NAME **and** the same src MODULE ──
        // Together, not either. Two records claiming the same function in the same file are one
        // record twice; either half alone is a naming convention or a function-granularity harvest.
        if !id.is_empty() && !name.is_empty() && !src.is_empty() {
            let key = format!("{name}\u{0}{}", same_module_path(&src));
            buckets.entry(("name-and-src", key)).or_default().insert(id);
        }
    }

    // Cluster the body pairs into connected components, with the same density guard the component
    // detector uses — a sparse component is a chain, and collapsing it invents a group.
    let mut adj: std::collections::BTreeMap<&str, std::collections::BTreeSet<&str>> =
        std::collections::BTreeMap::new();
    for (a, b) in &pairs {
        adj.entry(a).or_default().insert(b);
        adj.entry(b).or_default().insert(a);
    }
    let mut seen: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
    for start in adj.keys().copied() {
        if seen.contains(start) {
            continue;
        }
        let (mut stack, mut group): (Vec<&str>, Vec<&str>) = (vec![start], Vec::new());
        while let Some(n) = stack.pop() {
            if !seen.insert(n) {
                continue;
            }
            group.push(n);
            for m in adj.get(n).into_iter().flatten() {
                if !seen.contains(m) {
                    stack.push(m);
                }
            }
        }
        if group.len() < 2 {
            continue;
        }
        let members: std::collections::BTreeSet<&str> = group.iter().copied().collect();
        let observed = pairs.iter().filter(|(a, b)| members.contains(a) && members.contains(b)).count();
        let possible = group.len() * (group.len() - 1) / 2;
        if possible == 0 || (observed as f64) / (possible as f64) < CLUSTER_DENSITY {
            continue; // a chain, not a group
        }
        // Keyed on the cluster's own smallest id, NOT a constant. A constant key merged every body
        // cluster into one bucket, so two unrelated duplicate pairs (measured 0.002 similar to each
        // other) reported as a single group of four — a confident wrong grouping, which is exactly
        // what the density guard above exists to prevent. Connected components are disjoint, so the
        // smallest member is a stable unique name for the cluster.
        group.sort_unstable();
        buckets
            .entry(("same-body", group[0].to_string()))
            .or_default()
            .extend(group.iter().map(|s| (*s).to_string()));
    }

    // Collapse to one entry per MEMBER SET, carrying every signal that grouped it.
    let mut by_members: std::collections::BTreeMap<Vec<String>, Vec<String>> = std::collections::BTreeMap::new();
    for ((signal, key), ids) in buckets {
        if ids.len() < 2 {
            continue;
        }
        let desc = match signal {
            "name-and-src" => {
                let (name, src) = key.split_once('\u{0}').unwrap_or((key.as_str(), ""));
                format!("the same `name` (`{name}`) in the same module (`{src}`)")
            }
            // The body itself is never echoed — that it is the same body IS the finding.
            _ => format!("a near-identical body (≥{}% shingle overlap)", (NEAR_DUPLICATE * 100.0) as u32),
        };
        by_members.entry(ids.into_iter().collect()).or_default().push(desc);
    }

    let mut out: Vec<(usize, Value)> = by_members
        .into_iter()
        .map(|(ids, signals)| {
            let n = ids.len();
            let v = serde_json::json!({
                "category": "duplicate-candidate",
                "ids": ids,
                "signals": signals,
                "detail": format!("{n} implementations share {} — {}", signals.join(" and "), ids.join(", ")),
                "suggestion": format!(
                    "pick the survivor, then fold the others into it with `bsc graph merge <from> <into>` \
                     (it repoints every consumer). PROPOSE-ONLY — nothing is merged automatically, because \
                     which one survives is not a diagnostic's call. Candidates: {}",
                    ids.join(", ")
                ),
            });
            (n, v)
        })
        .collect();
    // Biggest groups first — the widest duplication is the one worth acting on.
    out.sort_by_key(|g| std::cmp::Reverse(g.0));
    out.into_iter().map(|(_, v)| v).collect()
}

/// A record's `src` reduced to the module it names, so two spellings of one path compare equal.
///
/// The store holds both conventions — `src/shared/ui/registry.tsx` and `app/console/lib/focusQueue.ts` —
/// because records arrived from different eras of the harvest, and Windows contributes backslashes on top.
/// Comparing the raw strings made the stem-collision guard fire on a record whose `src` is the SAME FILE,
/// which is the worst possible failure for a guard: it refused the honest case (re-harvesting a module
/// over its own stale record) while still catching nothing the normalization misses. Six modules were
/// blocked this way — `focusQueue`, `jumbleProbe`, `hashString`, `sort`, `selectionNeighborhood` — each
/// reported as "already names a DIFFERENT module" against itself.
fn same_module_path(src: &str) -> String {
    let unix = src.replace('\\', "/");
    let trimmed = unix.trim_start_matches("./");
    trimmed.strip_prefix("src/").unwrap_or(trimmed).to_string()
}

/// Do two normalized module paths name the same module, one possibly being the ABSOLUTE form?
///
/// A harvest target is typically absolute (`C:/…/src/features/x/y.ts`) while a record's `src` is
/// repo-relative (`src/features/x/y.ts`), so equality is the wrong test and a bare `ends_with` is too
/// loose — `…/colorHue.ts` would match a record for `myColorHue.ts`. The suffix has to begin at a
/// path BOUNDARY.
fn module_paths_agree(a: &str, b: &str) -> bool {
    let boundary_suffix = |hay: &str, needle: &str| {
        !needle.is_empty()
            && hay.len() > needle.len()
            && hay.ends_with(needle)
            && hay.as_bytes()[hay.len() - needle.len() - 1] == b'/'
    };
    a == b || boundary_suffix(a, b) || boundary_suffix(b, a)
}

/// Would joining these sources to a root named `root_name` double the prefix — `src/` under `src/`?
///
/// `bsc graph tests harvest <dir>` takes the REPO root, because every `src` is repo-relative and already
/// begins `src/`. Handed `src` instead, every join becomes `src/src/…`, nothing resolves, and the command
/// still exits 0 reporting a plausible `paired: 31 · noColocatedTest: 876`. That number reads as "the
/// algorithm tier has no tests" and was filed as a defect twice before anyone re-read the invocation —
/// so the wrong root has to be refused, not absorbed.
///
/// A MAJORITY, never a single hit: a repo may genuinely hold `<root>/<root>/…`, and one stray path must
/// not veto an otherwise correct run.
fn root_doubles_source_prefix(root_name: &str, srcs: &[&str]) -> bool {
    if root_name.is_empty() || root_name == "." || srcs.is_empty() {
        return false;
    }
    let prefix = format!("{root_name}/");
    let doubled = srcs.iter().filter(|s| s.starts_with(&prefix)).count();
    doubled * 2 > srcs.len()
}

/// Group the pairings by test FILE, returning `(distinct files, the ones claimed by more than one impl)`.
///
/// A module exporting several functions yields one impl each, and they all pair with that module's single
/// test file. Carrying it onto each is right for the MIRROR — the coverage really is theirs, and per-impl
/// attribution is not recoverable from the file — and is a trap for any EXECUTOR that materializes one
/// file per record, because the same assertions would then run once per impl and be counted that many
/// times. Measured here: 74 files cover 195 impls. Whoever consumes a harvest has to be able to see which
/// pairings are shared, so it is reported rather than left to be discovered downstream.
fn shared_test_pairings(paired: &[Value]) -> (usize, Vec<Value>) {
    let mut by_test: std::collections::BTreeMap<&str, Vec<&str>> = std::collections::BTreeMap::new();
    for c in paired {
        let t = c.get("test").and_then(Value::as_str).unwrap_or("");
        let i = c.get("id").and_then(Value::as_str).unwrap_or("");
        by_test.entry(t).or_default().push(i);
    }
    let shared = by_test
        .iter()
        .filter(|(_, ids)| ids.len() > 1)
        .map(|(t, ids)| serde_json::json!({ "test": t, "impls": ids }))
        .collect();
    (by_test.len(), shared)
}

/// The record that already covers `target`, and WHICH signal matched — `src` provenance or the
/// `provides` specifier (#75, designer request).
///
/// A harvest target absent from disk is the NORMAL end state for an already-migrated module in this
/// codebase, not an error: the file is retired once the record supersedes it. `no such path`
/// describes only the filesystem, so the one reading left is that the tool cannot see the tree —
/// which is exactly the false conclusion that got filed, then generalized into a claim that
/// `bsc ui harvest` and `bsc graph harvest` have different allowed roots. They do not.
pub fn record_covering_path(target: &str) -> Option<(String, String)> {
    record_covering_path_in(&crate::implementations(), target)
}

/// [`record_covering_path`] over an explicit impl list — the pure half, so the lookup is testable
/// without redirecting the process-global store env var.
fn record_covering_path_in(impls: &[Value], target: &str) -> Option<(String, String)> {
    let want = same_module_path(target);
    // `provides` carries no extension (`@/features/designs/lib/colorHue`), so the specifier compares
    // against the target's STEM rather than its filename.
    let want_stem = want.rsplit_once('.').map(|(s, _)| s.to_string()).unwrap_or_else(|| want.clone());
    for im in impls {
        let id = im.get("id").and_then(Value::as_str).unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        if let Some(src) = im.get("src").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
            if module_paths_agree(&same_module_path(src), &want) {
                return Some((id.to_string(), format!("its `src` is `{src}`")));
            }
        }
        if let Some(p) = im.get("provides").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
            let spec = same_module_path(p.trim_start_matches("@/"));
            if module_paths_agree(&spec, &want_stem) {
                return Some((id.to_string(), format!("it provides `{p}`")));
            }
        }
    }
    None
}

pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    // Before anything reads a flag: an unknown one is an ERROR, never a silent no-op (#4154).
    reject_unknown_flags(&args)?;
    let pretty = args.iter().any(|a| a == "--pretty");
    let positional: Vec<&str> = args.iter().filter(|a| !a.starts_with("--")).map(String::as_str).collect();
    let verb = positional.first().copied().unwrap_or("help");
    let emit = |v: &Value| -> Result<(), String> {
        let s = if pretty { serde_json::to_string_pretty(v) } else { serde_json::to_string(v) };
        // Through `bsc_util::emit_line`, NOT `println!`
        // (#request-list-cannot-be-warm-served-until-it-stops-using-println).
        //
        // `emit_line` is identical to `println!` when nothing is capturing, so one-shot CLI output is
        // unchanged byte for byte. It differs only inside a capture — and TWO things needed that. The
        // warm server (#4152) runs a verb under `capture_output`, so a raw `println!` writes into the
        // protocol stream and made every `bsc graph` verb structurally unservable. And `migrate-crate`
        // delegates to these same arms: with a raw `println!` its capture was a no-op, so one migration
        // buried its own report under 295 KB of record JSON.
        bsc_util::emit_line(&s.map_err(|e| e.to_string())?);
        Ok(())
    };
    match verb {
        // `test <id> --out <dir> [--run]` (run-a-records-paired-test-in-isolation) — materialize ONE
        // record into an empty directory and, optionally, run its paired tests there.
        //
        // Materializing exactly one record is what makes the run mean something: a suite that passes in
        // a directory containing only the record has PROVED the record is self-contained, which no run
        // inside the repo can prove — there, every import resolves whether the record declares it or not.
        "test" if args.iter().any(|a| a == "--all") => {
            // EVERY record carrying a paired test, each in its OWN directory. Sharing one would let a
            // record's test import a sibling record's file and pass on it — the cross-contamination the
            // single-record materializer exists to prevent.
            let out = flag_value(&args, "--out").ok_or("usage: bsc graph test --all --out <dir> [--run]")?;
            let run = args.iter().any(|a| a == "--run");
            let g = crate::load();
            let mut results = Vec::new();
            let (mut passed, mut failed, mut skipped) = (0usize, 0usize, 0usize);
            for im in crate::implementations_of(&g) {
                let Some(id) = im.get("id").and_then(Value::as_str) else { continue };
                if im.get("tests").and_then(Value::as_array).is_none_or(|t| t.is_empty()) {
                    // Counted, never hidden: a total that silently omits untested records reads as full
                    // coverage of a library most of which nothing checks.
                    skipped += 1;
                    continue;
                }
                let dir = std::path::Path::new(&out).join(id);
                // Reuse the single-record path rather than a second materializer — one implementation
                // of "what a record's filesystem contains" is the point.
                match single_record_test(id, &dir.to_string_lossy(), run, &g) {
                    Ok(v) => {
                        let ok = v.get("passed").and_then(Value::as_bool).unwrap_or(!run);
                        if run && !ok { failed += 1 } else { passed += 1 }
                        results.push(v);
                    }
                    Err(e) => {
                        failed += 1;
                        results.push(serde_json::json!({ "id": id, "error": e }));
                    }
                }
            }
            emit(&serde_json::json!({
                "records": results.len(), "passed": passed, "failed": failed,
                "skippedNoTest": skipped, "ran": run, "results": results,
            }))?;
            // A runner nothing can fail is not a gate.
            if failed > 0 {
                return Err(format!("{failed} record(s) failed their paired tests"));
            }
            Ok(())
        }
        "test" => {
            let id = positional.get(1).ok_or("usage: bsc graph test <id> --out <dir> [--run]")?;
            let out = flag_value(&args, "--out").ok_or("usage: bsc graph test <id> --out <dir> [--run]")?;
            let run = args.iter().any(|a| a == "--run");
            let g = crate::load();
            emit(&single_record_test(id, &out, run, &g)?)
        }
        // `edge …` (integration-tests-become-graph-edges) — the RELATIONSHIP tier. A test spanning two
        // records is evidence about the edge between them, not a property of either node, so it lives
        // here rather than being forced onto one of them or deleted.
        //   edge set --id <id> --members a,b [--src <test-file>]   # --src is READ, so a large test never
        //                                                          # has to fit through argv
        //   edge list | edge get <id> | edge remove <id>
        "edge" => match positional.get(1).copied() {
            Some("set") => {
                let id = flag_value(&args, "--id").ok_or("usage: bsc graph edge set --id <id> --members a,b [--src <test-file>]")?;
                let members = list_flag(flag_value(&args, "--members").as_deref());
                let mut e = serde_json::json!({ "id": id, "members": members });
                // The test source is READ from the file rather than passed: an integration test is
                // routinely larger than the argv limit, which is the same wall `impl set --code` hit.
                if let Some(p) = flag_value(&args, "--src") {
                    let path = std::path::Path::new(&p);
                    bsc_cli_util::require_harvestable_root(path)?;
                    let contents = std::fs::read_to_string(path).map_err(|err| format!("cannot read {p}: {err}"))?;
                    let name = bsc_util::test_display_name(path, &contents);
                    e["tests"] = serde_json::json!([{ "name": name, "src": contents }]);
                    e["src"] = Value::String(p.replace(crate::extract::BACKSLASH, "/"));
                }
                let mut g = crate::load();
                let updated = crate::set_edge(&mut g, e)?;
                crate::save(&g)?;
                emit(&serde_json::json!({ "ok": true, "updated": updated }))
            }
            Some("remove") => {
                let id = positional.get(2).ok_or("usage: bsc graph edge remove <id>")?;
                let mut g = crate::load();
                let removed = crate::remove_edge(&mut g, id);
                crate::save(&g)?;
                emit(&serde_json::json!({ "removed": removed }))
            }
            Some("get") => {
                let id = positional.get(2).ok_or("usage: bsc graph edge get <id>")?;
                let g = crate::load();
                let found = crate::edges_of(&g).into_iter().find(|e| e.get("id").and_then(Value::as_str) == Some(*id));
                emit(&found.unwrap_or(Value::Null))
            }
            Some("list") | None => emit(&Value::Array(crate::edges_of(&crate::load()))),
            Some(other) => Err(format!("unknown edge subverb '{other}' — want one of: {}", EDGE_SUBVERBS.join(" | "))),
        },
        // `impl …` — read / curate the language-kit implementation tier (#2863/#2961/#2972/#3120):
        //   impl set --tech <lang> --id <id> --role primitive|algorithm --name <n> [--code <c>|--code-file <p>] [--ref <std-path>] [--composes a,b] [--summary <s>] [--domain <d>] [--tags a,b]
        //     #76: `--code-file`/`--viz-code-file` read the value from DISK. Prefer them — argv cannot
        //     carry source intact (the shell eats backticks and `${…}`), and it fails silently.
        //     (algorithm: real --code; primitive: DESCRIBE a language built-in via --ref, e.g. std::vec::Vec — never re-coded, #2972)
        //   impl remove <id>                             # delete an implementation + scrub it from every composes
        //   impl get <id-or-name> | impl list [--tech <t>] [--role r] [--domain <d>]  # a language kit's implementations, optionally a domain collection (#3120); get falls back to a bare NAME when it's unambiguous (#118)
        "impl" => match positional.get(1).copied() {
            Some("set") => {
                let id = flag_value(&args, "--id").ok_or("usage: bsc graph impl set --tech <lang> --id <id> --role primitive|algorithm --name <name> [--code <code>] [--ref <std-path>] [--composes a,b] [--summary <s>] [--domain <d>] [--tags a,b] [--kind sort|search|traversal|accumulate]")?;
                let tech = flag_value(&args, "--tech").ok_or("usage: bsc graph impl set … --tech <language>")?;
                let role = flag_value(&args, "--role").ok_or("usage: bsc graph impl set … --role primitive|algorithm")?;
                let name = flag_value(&args, "--name").ok_or("usage: bsc graph impl set … --name <name>")?;
                // #4154: `composes` is included ONLY when supplied. It used to default to `[]` on every
                // write, so a `--domain`-only edit blanked an impl's whole composes graph — the same
                // destructive-default class as the full-record overwrite `set_impl` no longer does.
                let mut im = serde_json::json!({ "id": id, "tech": tech, "role": role, "name": name });
                if let Some(c) = flag_value(&args, "--composes") {
                    im["composes"] = list_flag(Some(c.as_str()));
                }
                if let Some(s) = flag_value(&args, "--summary") { im["summary"] = Value::String(s); }
                // A primitive DESCRIBES a language built-in via `--ref` (std path), rather than re-coding it (#2972).
                if let Some(r) = flag_value(&args, "--ref") { im["ref"] = Value::String(r); }
                // #76 — `--code` OR `--code-file`; the file form is the one large or backtick-bearing
                // source can survive, since argv cannot carry it intact.
                if let Some(code) = source_flag(&args, "--code")? { im["code"] = Value::String(code); }
                // The domain facet (#3120) — additive: only written when supplied, so existing impls are untouched.
                if let Some(d) = flag_value(&args, "--domain") { im["domain"] = Value::String(d); }
                // #4107: settable directly, but normally DERIVED — pass `--src` and the folder follows,
                // so a hand-authored impl lands in the same tree a harvested one would.
                if let Some(sp) = flag_value(&args, "--src") {
                    if let Some(f) = bsc_util::folder_from_src(&sp) { im["folder"] = Value::String(f); }
                    im["src"] = Value::String(sp);
                }
                if let Some(f) = flag_value(&args, "--folder") { im["folder"] = Value::String(f); }
                // The `@/…` specifier this impl SATISFIES — what a component's import matches on, the
                // same field the component store already carries. Additive like `--domain`: written only
                // when supplied, so no existing impl gains one by accident.
                if let Some(p) = flag_value(&args, "--provides") { im["provides"] = Value::String(p); }
                // HOW THIS MODULE IS DECLARED, for a record that a build materializes into a crate.
                //
                // A `mod` declaration carries meaning the module body does not, and materializing one
                // without it changes the program. `crates/data` gated three modules behind
                // `#[cfg(feature = "duckdb-store")]`; emitting an unconditional `pub mod` made all three
                // unconditional — a correctness regression that clippy caught only by accident, because
                // the orphaned attribute happened to be left behind. And 38 declarations across the
                // workspace are PRIVATE, where `pub mod` would widen the crate's API.
                //
                // So the declaration rides on the record. `--module-attrs-file` rather than an inline
                // flag for the same reason `--code-file` exists: `#[cfg(feature = "x")]` through a shell
                // loses its quotes and brackets silently.
                if let Some(v) = flag_value(&args, "--module-vis") {
                    im["moduleVis"] = Value::String(v);
                }
                if let Some(p) = flag_value(&args, "--module-attrs-file") {
                    let raw = std::fs::read_to_string(&p).map_err(|e| format!("cannot read {p}: {e}"))?;
                    let attrs: Vec<Value> = raw
                        .lines()
                        .map(str::trim)
                        .filter(|l| !l.is_empty())
                        .map(|l| Value::String(l.to_string()))
                        .collect();
                    im["moduleAttrs"] = Value::Array(attrs);
                }
                // The module's own STATE, comma-separated. A module harvest sets this itself, but an
                // impl written through THIS verb could not carry it at all — which stranded 27 of the
                // 58 stateful modules with no record of what they hold, precisely because a colliding
                // id forced them down the `impl set` path instead of `--apply`.
                //
                // SETS only. `im` is the MERGE payload (#4154), so dropping a key here means "leave it
                // alone", never "remove it" — clearing is what `--clear moduleState` is for, and having
                // two ways to clear one field is how they drift apart.
                // THE SURFACE RESTRICTION (the-data-graph-a-global-third-pillar). A node declares the
                // data-graph entities it is responsible for, and is held to it — the algorithm↔data
                // leg, which was the one edge of the three-pillar model with no mechanism at all.
                // Declared here rather than inferred, because the point is to BOUND a node's reach:
                // an inferred set can only ever describe what the code already does.
                for (flag, key) in [("--reads", "reads"), ("--writes", "writes")] {
                    if let Some(v) = flag_value(&args, flag) {
                        let names: Vec<Value> = v
                            .split(',')
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(|s| Value::String(s.to_string()))
                            .collect();
                        if !names.is_empty() {
                            im[key] = Value::Array(names);
                        }
                    }
                }
                if let Some(ms) = flag_value(&args, "--module-state") {
                    let names: Vec<Value> = ms
                        .split(',')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(|s| Value::String(s.to_string()))
                        .collect();
                    if !names.is_empty() {
                        im["moduleState"] = Value::Array(names);
                    }
                }
                // #4136: an ALGORITHM must declare its provenance, or explicitly declare it has none.
                //
                // The librarian curated 10 algorithms through this verb with no `--src`, so none could
                // sit in the folder tree the rail organizes by — it did exactly what its spec said, and
                // the CLI accepted a provenance-less record silently. Absence is now EXPLICIT: pass
                // `--src` (the folder derives from it), `--folder`, or `--no-src` for a canonical
                // algorithm that genuinely has no file in this repo. A PRIMITIVE is exempt by design —
                // it DESCRIBES a language built-in via `--ref` and is never re-coded (#2972).
                // #4154: with a merging write, a value can no longer be removed by omitting it — so
                // removal becomes EXPLICIT. `--clear a,b` drops those fields from the stored record.
                let cleared: Vec<String> = flag_value(&args, "--clear")
                    .map(|v| v.split(',').map(|f| f.trim().to_string()).filter(|f| !f.is_empty()).collect())
                    .unwrap_or_default();
                for f in &cleared {
                    im[f.as_str()] = Value::Null;
                }
                // Load BEFORE the gate (#4154): the check must see the STORED record. It used to inspect
                // only this write's flags, so editing a record that ALREADY had `src`/`folder` was
                // rejected unless the caller resupplied them — pushing every routine `--domain`/`--kind`
                // edit into restating provenance, which is the exact shape that caused the loss the
                // merge now prevents. It blocked 14 TypeScript + 3 fleet entries (designer request #52).
                let mut g = crate::load();
                let stored = crate::implementations_of(&g)
                    .into_iter()
                    .find(|x| x.get("id").and_then(Value::as_str) == Some(id.as_str()));
                if !provenance_declared(&role, &im, stored.as_ref(), args.iter().any(|a| a == "--no-src")) {
                    return Err(format!(
                        "impl set: algorithm '{id}' has no provenance — pass --src <path> (the folder                          derives from it), --folder <path>, or --no-src if it has no source in this repo.                          Without one it cannot be organized in the graph's folder tree (#4136)."
                    ));
                }
                if let Some(t) = flag_value(&args, "--tags") { im["tags"] = list_flag(Some(t.as_str())); }
                // The kind facet (#3210) — the manipulation type that selects the live animation. Additive.
                if let Some(k) = flag_value(&args, "--kind") { im["kind"] = Value::String(k); }
                // The viz-code facet (#3218) — the algorithm's visualization as a JS trace-program. Additive.
                // A trace-program is JS and routinely carries both backticks and `${…}`, so this is the
                // flag most likely to be corrupted in transit — see `source_flag`.
                if let Some(v) = source_flag(&args, "--viz-code")? { im["vizCode"] = Value::String(v); }
                let replaced = crate::set_impl_by(&mut g, im.clone(), &bsc_record::resolve_writer(flag_value(&args, "--by").as_deref()), flag_value(&args, "--note").as_deref())?;
                crate::save(&g)?;
                // Report the STORED record, not the write payload (#4154). Echoing `im` showed only the
                // fields this call restated, so a `--domain`-only edit answered without `src`, `summary`
                // or `tests` — which reads as "they were deleted". That is what the merge fix was
                // measured against and judged still broken across three separate probes (request #52):
                // the data was intact the whole time and the ACK was lying about it.
                let saved = crate::implementations_of(&g)
                    .into_iter()
                    .find(|x| x.get("id").and_then(Value::as_str) == Some(id.as_str()))
                    .unwrap_or(im);
                emit(&serde_json::json!({ "ok": true, "action": if replaced { "updated" } else { "created" }, "impl": saved }))
            }
            Some("remove") => {
                let id = positional.get(2).ok_or("usage: bsc graph impl remove <id>")?;
                // A SEEDED id cannot be removed — the seed reconcile re-adds it by design, so reporting
                // `removed` would be a lie the caller discovers on their next read (request #71). Refuse
                // and name the verb that does work, rather than succeeding at nothing.
                if crate::is_seeded(id) {
                    return Err(format!(
                        "'{id}' is a PACKAGED algorithm — a plain remove re-seeds on the next load. Use                          `bsc graph impl suppress {id}` to retire it durably (add `--superseded-by <new-id>`                          when something replaces it), or `impl unsuppress` to bring it back."
                    ));
                }
                let mut g = crate::load();
                if crate::remove_impl(&mut g, id) {
                    crate::save(&g)?;
                    emit(&serde_json::json!({ "ok": true, "removed": id }))
                } else {
                    Err(format!("unknown implementation '{id}'"))
                }
            }
            // #71 — RETIRE a packaged algorithm durably. Mirrors `bsc ui suppress` (#3725): a
            // `{ id, suppressed: true }` tombstone OCCUPIES the id, so the seed reconcile's absent-id
            // check finds it present and stops re-adding the packaged impl. `--superseded-by` records
            // what replaced it, on the tombstone because that is the one record the reconcile never
            // overwrites — a consolidation is otherwise unauditable a month later.
            // #72 — READ the write log. `impl set` stamps rev/by/at/changed through the same
            // `bsc-record` the component store uses, so this reads like `bsc ui log <id>` on purpose:
            // one vocabulary across both stores rather than two dialects a reader has to translate.
            Some("history") => {
                let id = positional.get(2).ok_or("usage: bsc graph impl history <id>")?;
                let g = crate::load();
                let rec = crate::implementations_of(&g)
                    .into_iter()
                    .find(|im| im.get("id").and_then(Value::as_str) == Some(*id))
                    .ok_or_else(|| format!("unknown implementation '{id}'"))?;
                emit(&bsc_record::log_value(id, &rec))
            }
            // #72 — restore a previous `code`. REFUSES rather than landing on a nearer revision: the
            // rung is retained for only the most recent few source-moving writes, so a silent
            // approximation would hand back code the caller never asked for and call it a revert.
            Some("revert") => {
                let id = positional.get(2).ok_or("usage: bsc graph impl revert <id> [--to <rev>]")?;
                let mut g = crate::load();
                let rec = crate::implementations_of(&g)
                    .into_iter()
                    .find(|im| im.get("id").and_then(Value::as_str) == Some(*id))
                    .ok_or_else(|| format!("unknown implementation '{id}'"))?;
                let revertible = bsc_record::revertible_revs(&rec);
                // Default: the revision immediately before this one — "undo the last write".
                let want = match flag_value(&args, "--to") {
                    Some(v) => v.parse::<i64>().map_err(|_| format!("--to: not a revision number: {v}"))?,
                    None => *revertible.last().ok_or_else(|| format!(
                        "'{id}' has no retained code to revert to — its history holds no source-moving write"
                    ))?,
                };
                let code = bsc_record::src_at_rev_of(&rec, want, "code").ok_or_else(|| format!(
                    "'{id}' cannot be reverted to rev {want} — that revision's code is not retained.                      Revertible: {}",
                    if revertible.is_empty() { "(none)".into() } else {
                        revertible.iter().map(i64::to_string).collect::<Vec<_>>().join(", ")
                    }
                ))?;
                let mut next = rec.clone();
                next["code"] = Value::String(code);
                let writer = bsc_record::resolve_writer(flag_value(&args, "--by").as_deref());
                crate::set_impl_by(&mut g, next, &writer, Some(&format!("revert to rev {want}")))?;
                crate::save(&g)?;
                emit(&serde_json::json!({ "ok": true, "reverted": id, "to": want }))
            }
            Some("suppress") => {
                let id = positional.get(2).ok_or("usage: bsc graph impl suppress <id> [--superseded-by <new-id>]")?;
                let mut g = crate::load();
                let live: Vec<Value> = crate::implementations_of(&g);
                let known = |x: &str| live.iter().any(|im| im.get("id").and_then(Value::as_str) == Some(x));
                if !known(id) && !crate::is_seeded(id) {
                    return Err(format!("unknown implementation '{id}'"));
                }
                let mut tomb = serde_json::json!({ "id": id });
                if let Some(new_id) = flag_value(&args, "--superseded-by") {
                    // REFUSED, not stored, on a dangling or self pointer — the tombstone is durable, so a
                    // pointer naming something nobody can open outlives everyone who could correct it.
                    if new_id == *id {
                        return Err(format!("'{id}' cannot supersede itself"));
                    }
                    if !known(&new_id) {
                        return Err(format!(
                            "--superseded-by '{new_id}' is not a live implementation — author it first, or omit the flag"
                        ));
                    }
                    tomb["supersededBy"] = Value::String(new_id);
                }
                crate::remove_impl(&mut g, id);
                // Idempotent (#77) — suppressing an already-suppressed id refreshes its pointer
                // instead of appending a second tombstone for the same id.
                crate::add_suppression(&mut g, id, tomb.get("supersededBy").and_then(Value::as_str));
                crate::save(&g)?;
                emit(&serde_json::json!({ "ok": true, "suppressed": id, "supersededBy": tomb.get("supersededBy") }))
            }
            Some("unsuppress") => {
                let id = positional.get(2).ok_or("usage: bsc graph impl unsuppress <id>")?;
                let mut g = crate::load();
                let is_tomb = crate::is_suppressed(&g, id);
                // REFUSES on a live impl: a real record goes through `remove`, never this. Otherwise
                // `unsuppress` becomes a second, quieter delete.
                if !is_tomb {
                    return Err(format!("'{id}' is not a suppression tombstone — nothing to restore"));
                }
                crate::ensure_array(&mut g, "suppressed")
                    .retain(|t| t.get("id").and_then(Value::as_str) != Some(*id));
                let reseeded = crate::reconcile_seed(&mut g);
                crate::save(&g)?;
                emit(&serde_json::json!({ "ok": true, "unsuppressed": id, "reseeded": reseeded }))
            }
            // #4156 (designer request #47): read ONE impl by id. Without it, verifying a record before a
            // write meant dumping a whole language kit — 52.7KB for Rust — which overflows the shell,
            // gets truncated to a file OUTSIDE the session's confined FS roots, and so cannot be read
            // back at all. The designer skipped correcting several entries rather than write blind.
            Some("get") => {
                let ref_ = positional.get(2).copied().ok_or("usage: bsc graph impl get <id-or-name>")?;
                let impls = crate::implementations();
                let by_id = impls.iter().find(|im| im.get("id").and_then(Value::as_str) == Some(ref_));
                // #118: every OTHER reader of this library — `resolveLibrarySpec`/`libraryModuleResolver`
                // (the preview's `@bsc/algorithms/<name>` import) and this crate's own `resolves_library`
                // (`graph_health.rs`) — accepts an algorithm's BARE name interchangeably with its exact
                // id. `impl get` did not, so a designer verifying a `bsc ui doctor` finding like "re-codes
                // `models` (import `@bsc/algorithms/models`)" by running `impl get models` got `null` and
                // reasonably read that as "the target doesn't exist" — when it does, under id `models.ts`,
                // and the import in the finding already resolves and builds. Fall back to a NAME match,
                // but only when it is UNAMBIGUOUS: an id is unique by construction, a name is not (`index`
                // alone names 20 unrelated modules in this store), and a wrong silent pick on a read that
                // precedes a write is worse than the miss this verb already treats as a normal answer.
                let found = match by_id {
                    Some(im) => Some(im),
                    None => {
                        let mut by_name = impls.iter().filter(|im| im.get("name").and_then(Value::as_str) == Some(ref_));
                        match (by_name.next(), by_name.next()) {
                            (Some(only), None) => Some(only),
                            (Some(_), Some(_)) => {
                                let ids: Vec<&str> = impls
                                    .iter()
                                    .filter(|im| im.get("name").and_then(Value::as_str) == Some(ref_))
                                    .filter_map(|im| im.get("id").and_then(Value::as_str))
                                    .collect();
                                return Err(format!(
                                    "'{ref_}' names {} implementations — pass the exact --id instead: {}",
                                    ids.len(),
                                    ids.join(", ")
                                ));
                            }
                            (None, _) => None,
                        }
                    }
                };
                match found {
                    // `--metrics` (#doctor-reads-the-runtime) JOINS the runtime attestations at read
                    // time, under a `metrics` key. Deliberately not a field ON the record: writing it
                    // there would make every boot a record write (filling `bsc ui revert` history with
                    // timing noise instead of authorship), vendor a second copy of a constantly-changing
                    // number — the drift #4191 forbids for algorithm bodies — and ship one machine's
                    // numbers to another inside a seed or a Studio snapshot.
                    Some(im) if args.iter().any(|a| a == "--metrics") => {
                        let mut out = im.clone();
                        let metrics_id = im.get("id").and_then(Value::as_str).unwrap_or(ref_);
                        if let Some(obj) = out.as_object_mut() {
                            obj.insert("metrics".into(), runtime_metrics(metrics_id));
                        }
                        emit(&out)
                    }
                    Some(im) => emit(im),
                    // `null` rather than an error: a miss is a normal answer to "does this exist?", and
                    // it keeps the output parseable by the same reader as a hit.
                    None => emit(&Value::Null),
                }
            }
            Some("list") => {
                let tech = flag_value(&args, "--tech");
                let role = flag_value(&args, "--role");
                // The domain facet filter (#3120) — a cross-language domain collection ("all logistics algorithms").
                let domain = flag_value(&args, "--domain");
                let impls: Vec<Value> = crate::implementations()
                    .into_iter()
                    .filter(|im| tech.as_deref().is_none_or(|t| im.get("tech").and_then(Value::as_str) == Some(t)))
                    .filter(|im| role.as_deref().is_none_or(|r| im.get("role").and_then(Value::as_str) == Some(r)))
                    .filter(|im| domain.as_deref().is_none_or(|d| crate::impl_in_domain(im, d)))
                    .collect();
                emit(&Value::Array(impls))
            }
            // Every subverb in `IMPL_SUBVERBS`, in its order — the roster a caller who guessed wrong
            // needs is the WHOLE roster, and half of it used to be missing from this line.
            _ => Err("usage: bsc graph impl set … | impl get <id-or-name> | impl remove <id> \
                      | impl list [--tech <t>] [--role r] [--domain <d>] \
                      | impl suppress <id> [--superseded-by <new-id>] | impl unsuppress <id> \
                      | impl history <id> | impl revert <id> [--to <rev>]"
                .to_string()),
        },
        // `harvest <dir> [--tech typescript|rust] [--worthy-only]` — the extract-to-harvest feeder
        // (#2745): parse a project's real code and lift each function into a CANDIDATE library
        // implementation (id/name/tech/role/composes/code), each CLASSIFIED library-worthy vs.
        // project-glue with a score + reasons (#2745 slice 2). `--worthy-only` keeps just the worthy
        // ones. Emits candidates ONLY — storing them into the library is the curation gate, never here.
        "harvest" => {
            let dir = positional
                .get(1)
                .ok_or("usage: bsc graph harvest <dir-or-file> [--tech typescript|rust] [--worthy-only] [--module [--apply]]")?;
            // #3475: a harvest hands back file CONTENTS, so it must honor the SAME boundary the
            // file tools do. `bsc-confine` only inspects Claude's file-tool payloads and is blind to
            // what this binary reads — without this, a confined studio session (the librarian is
            // limited to its own workspace) reads any path on disk through an allow-listed CLI.
            // `harvest help` asked for help, not for a directory named "help" — which the dir walk
            // dutifully found nothing in, printing an empty harvest as the answer to a help request.
            if *dir == "help" {
                print!("{}", help(prog));
                return Ok(());
            }
            let target = std::path::Path::new(dir);
            // A missing path must SAY so. Previously the dir walk's `read_dir` failed silently on
            // anything that was not a readable dir, so a typo and an empty tree were the same answer.
            if !target.exists() {
                // …but ASK THE STORE FIRST (#75). A target absent from disk is the normal end state
                // for an already-migrated module here — the file is retired once the record
                // supersedes it — so answering with the filesystem alone describes the least
                // interesting half of the truth and reads as a broken tool.
                if let Some((id, how)) = record_covering_path(dir) {
                    return Err(format!(
                        "nothing at {dir} — that module is ALREADY HARVESTED: `{id}` ({how}).\n\
                         Its file was retired when the record superseded it, which is the expected \
                         end state, not a missing path.\n\
                         Read the record with `{prog} impl get {id}`."
                    ));
                }
                return Err(format!("no such path: {dir}"));
            }
            bsc_cli_util::require_harvestable_root(target)?;
            let tech = flag_value(&args, "--tech");
            let worthy_only = args.iter().any(|a| a == "--worthy-only");
            // #4161: a FILE target harvests just that module — the route `bsc ui harvest <file>`
            // advertises. It used to fall into the dir walk and return a silent zero.
            // `--module` lifts the file as ONE module-shaped candidate instead of one per function —
            // the shape a runtime loader can vendor, and the only shape that can carry `provides`.
            // Directory targets keep the function granularity the reusable library is built on.
            let module_mode = args.iter().any(|a| a == "--module");
            let harvested = if module_mode {
                if !target.is_file() {
                    return Err("--module harvests ONE file; pass a file, not a directory".to_string());
                }
                let root = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
                crate::extract::harvest_module(target, &root).into_iter().collect()
            } else if target.is_file() {
                crate::extract::harvest_file(target)
            } else {
                crate::extract::harvest(target)
            };
            // `--apply` WRITES the harvest instead of only reporting it (harvest-module-can-persist).
            // Module mode only, and that is a guard rather than a limitation: a directory harvest would
            // write every function in the tree into the library as a side effect of asking what is there,
            // which is the curation decision `curate --apply` exists to make deliberately. One file, one
            // record, one specifier is the only shape where apply is unambiguous.
            //
            // It exists because `impl set --code <literal>` is the only other write path, and code on the
            // command line does not scale: two of the modules this migration lifts are 71 KB and 42 KB,
            // past the Windows `CreateProcess` argv limit, so they could not be written at all.
            let apply = args.iter().any(|a| a == "--apply");
            if apply && !module_mode {
                return Err(
                    "--apply writes ONE module as ONE record — pass --module with a file. \
                     A directory harvest would write every function it found; use `curate --apply` for that."
                        .to_string(),
                );
            }
            let picked: Vec<crate::extract::Candidate> = harvested
                .into_iter()
                .filter(|c| tech.as_deref().is_none_or(|t| c.tech == t))
                .filter(|c| !worthy_only || c.classification.worthy)
                .collect();
            // #77 — ids this run declined to write back because they are RETIRED. Declared out here so
            // it reaches the emit: a skip nobody is told about is how a caller comes to believe a
            // record was written when it was not.
            let mut retired: Vec<String> = Vec::new();
            if apply {
                let mut g = crate::load();
                // A module id is derived from the file STEM, so two `registry.tsx` in different
                // directories produce one id — and `impl set` is a MERGE by id, so the second harvest
                // silently REPLACED the first. One command, one record lost, no warning. Refuse the
                // write instead. A guard rather than a new id scheme on purpose: path-derived ids would
                // rename every module record already migrated and break the specifiers pointing at them.
                let existing = crate::implementations_of(&g);
                for c in &picked {
                    // AN ABSENT `src` IS NOT PROOF OF SAMENESS. This used to require a non-empty `src`
                    // before it would call anything a clash, so a CURATED library algorithm — which has
                    // no `src` by design (`--no-src`, #4136) — could never trigger it, and a module
                    // harvest merged straight over it. `sort.ts` was exactly that: the packaged
                    // insertion-sort generator, silently replaced by `viz/examples/sort.ts`, with the
                    // only symptom a duplicate id in the seed two steps later. Unknown provenance is a
                    // reason to REFUSE and make the author say which record they mean, not to proceed.
                    let clash = existing.iter().find(|im| {
                        im.get("id").and_then(Value::as_str) == Some(c.id.as_str())
                            && match im.get("src").and_then(Value::as_str) {
                                Some(s) if !s.is_empty() => {
                                    same_module_path(s) != same_module_path(&c.src)
                                }
                                _ => true, // no provenance: cannot prove it is the same module
                            }
                    });
                    if let Some(im) = clash {
                        let other = match im.get("src").and_then(Value::as_str) {
                            Some(s) if !s.is_empty() => s,
                            _ => "a record with NO src (a curated algorithm, or provenance never recorded)",
                        };
                        return Err(format!(
                            "'{}' already names a DIFFERENT module: {other}\n\
                             This harvest would overwrite it, because a module id comes from the file \
                             stem and `impl set` merges by id.\n\
                             Rename one of the files, or write the record deliberately with \
                             `bsc graph impl set --id <a-distinct-id>`.",
                            c.id
                        ));
                    }
                }
                for c in &picked {
                    // The same field set `curate --apply` writes — `domain` (invisible without it,
                    // #3607), `src` provenance (#4091), the `folder` derived from it (#4107), and the
                    // colocated tests (#4126) — PLUS `provides`, which is the whole point here: a module
                    // record the loader cannot match by specifier is a record nothing resolves through.
                    let mut im = serde_json::json!({
                        "id": c.id, "tech": c.tech, "role": c.role, "name": c.name,
                        "composes": c.composes, "code": c.code,
                        "domain": c.domain, "src": c.src,
                    });
                    // Only when NON-EMPTY. `tests: []` is not "no tests recorded" — it is a key the
                    // additive contract omits, so writing it made every migrated record fail the seed
                    // round-trip against its own typed model.
                    if !c.tests.is_empty() {
                        im["tests"] = Value::Array(
                            c.tests.iter().map(|t| serde_json::json!({ "name": t.name, "src": t.src })).collect(),
                        );
                    }
                    if let Some(f) = bsc_util::folder_from_src(&c.src) {
                        im["folder"] = Value::String(f);
                    }
                    // The module's own STATE, named on the record. Only when NON-EMPTY, like
                    // `tests`: the additive contract omits an absent key rather than writing one.
                    if !c.module_state.is_empty() {
                        im["moduleState"] = Value::Array(
                            c.module_state.iter().map(|n| Value::String(n.clone())).collect(),
                        );
                    }
                    // Set only when present. `impl set` is a MERGE (#4154), so writing an explicit null
                    // would CLEAR a specifier a previous run established rather than leaving it alone.
                    if let Some(p) = &c.provides {
                        im["provides"] = Value::String(p.clone());
                    }
                    set_impl_skipping_retired(&mut g, im, &mut retired)?;
                    // ROUTE THE INTEGRATION TEST (edges-fill-themselves-at-retirement). A colocated test
                    // that reaches other modules is not paired onto the node — but it must not be left
                    // behind either, because the file it lives in goes when the module retires. It
                    // becomes an EDGE: this record plus the specifiers it reaches.
                    //
                    // Those specifiers are usually still FILES at this moment, which is why a member may
                    // be a specifier rather than a record id — `doctor` reports them as PENDING and they
                    // resolve as the migration reaches them.
                    if let Some(t) = &c.edge_test {
                        let mut members = vec![Value::String(c.id.clone())];
                        members.extend(c.edge_members.iter().map(|m| Value::String(m.clone())));
                        crate::set_edge(
                            &mut g,
                            serde_json::json!({
                                // Keyed on the module, so a re-harvest UPDATES this edge rather than
                                // adding a second one for the same test file.
                                "id": format!("{}~integration", c.id),
                                "members": members,
                                // The TEST's path, not the module's — the edge is about the test.
                                "src": c.edge_src,
                                "tests": [{ "name": t.name, "src": t.src }],
                            }),
                        )?;
                    }
                }
                crate::save(&g)?;
            }
            let candidates: Vec<Value> = picked
                .iter()
                .map(|c| {
                    serde_json::json!({
                        "id": c.id,
                        "name": c.name,
                        "tech": c.tech,
                        "role": c.role,
                        "composes": c.composes,
                        "code": c.code,
                        // Provenance + facet (#4091) — a candidate you cannot trace to a file is not
                        // reviewable, and one with no domain is invisible once stored (#3607).
                        "src": c.src,
                        "domain": c.domain,
                        // The COLOCATED test, carried at harvest time (#4126) — so a curate lands a
                        // node that already declares its tests, with no second pass.
                        "tests": c.tests.iter().map(|t| serde_json::json!({ "name": t.name, "src": t.src })).collect::<Vec<_>>(),
                        "worthy": c.classification.worthy,
                        "score": c.classification.score,
                        "reasons": c.classification.reasons,
                        // Present only under `--module`: the specifier a component's import matches on.
                        // Omitted entirely at function granularity, where it would always be null and
                        // would read as "this impl has no specifier yet" rather than "cannot have one".
                        "provides": c.provides,
                        // The integration test routed to an edge, if any — visible in a dry harvest so
                        // the routing can be inspected before it is applied.
                        "edgeMembers": c.edge_members,
                        // #80 — specifiers REFUSED as members because they name no module (a mock, a
                        // `${…}` placeholder, a path to nothing). Reported so a genuinely missing
                        // module is not hidden by the rule that hides a fixture.
                        "edgeDeclined": c.edge_declined,
                        // The module's own STATE. `--apply` already stored this, but the printed
                        // candidate omitted it — so a DRY harvest could not show the one property that
                        // decides whether vendoring the record equals importing the module, and any
                        // script reading the output saw a stateful module as stateless.
                        "moduleState": c.module_state,
                    })
                })
                .collect();
            emit(&serde_json::json!({
                "applied": apply,
                "candidates": candidates,
                "count": candidates.len(),
                // #77 — named, not just counted: the caller needs to know WHICH module it asked to
                // store and did not get, so it can look up what superseded it.
                "skippedRetired": retired,
            }))
        }
        // `curate <dir> [--tech t] [--apply]` — the curation + optimize gate (#2745 slice 3): harvest +
        // classify a project, keep only the WORTHY candidates, and plan each into the library — an `add`,
        // or an `optimize` when the store already holds that id (the harvested version replaces it).
        // `--apply` writes them to the runtime store (`impl set` semantics); without it, a dry-run plan.
        "curate" => {
            let dir = positional
                .get(1)
                .ok_or("usage: bsc graph curate <dir> [--tech typescript|rust] [--apply]")?;
            // #3475: a harvest hands back file CONTENTS, so it must honor the SAME boundary the
            // file tools do. `bsc-confine` only inspects Claude's file-tool payloads and is blind to
            // what this binary reads — without this, a confined studio session (the librarian is
            // limited to its own workspace) reads any path on disk through an allow-listed CLI.
            bsc_cli_util::require_harvestable_root(std::path::Path::new(dir))?;
            let tech = flag_value(&args, "--tech");
            let apply = args.iter().any(|a| a == "--apply");
            let worthy: Vec<crate::extract::Candidate> =
                crate::extract::harvest(std::path::Path::new(dir))
                    .into_iter()
                    .filter(|c| tech.as_deref().is_none_or(|t| c.tech == t))
                    .filter(|c| c.classification.worthy)
                    .collect();
            let plan = crate::extract::curation_plan(&worthy, &crate::implementations());
            // #77 — same contract as `harvest --apply`: a retired id is skipped and named, not written
            // back and not fatal to the rest of the curation.
            let mut retired: Vec<String> = Vec::new();
            if apply {
                let mut g = crate::load();
                for item in &plan {
                    let c = &item.candidate;
                    // `domain` + `src` ride along (#4091). Without a domain the record does not
                    // surface in the graph UI at all (#3607), so a clean curate used to land work
                    // nobody could see; `src` is the provenance that makes a re-harvest dedupable
                    // and a record traceable to the file it came from.
                    // `folder` (#4107) is derived from `src` by the SAME `bsc_util::folder_from_src`
                    // components use, so harvest is 1:1 — the library organizes exactly like the tree
                    // it came from. A candidate whose `src` yields no directory stays unfoldered rather
                    // than being bucketed under "".
                    let mut im = serde_json::json!({
                        "id": c.id, "tech": c.tech, "role": c.role, "name": c.name,
                        "composes": c.composes, "code": c.code,
                        "domain": c.domain, "src": c.src,
                        // #4126 — tests ride in with the curation, so `bsc graph tests harvest` is only
                        // ever needed for records curated before harvest carried them.
                        "tests": c.tests.iter().map(|t| serde_json::json!({ "name": t.name, "src": t.src })).collect::<Vec<_>>(),
                    });
                    if let Some(f) = bsc_util::folder_from_src(&c.src) {
                        im["folder"] = Value::String(f);
                    }
                    set_impl_skipping_retired(&mut g, im, &mut retired)?;
                }
                crate::save(&g)?;
            }
            let items: Vec<Value> = plan
                .iter()
                .map(|it| {
                    serde_json::json!({
                        "id": it.candidate.id,
                        "name": it.candidate.name,
                        "tech": it.candidate.tech,
                        "role": it.candidate.role,
                        "domain": it.candidate.domain,
                        "src": it.candidate.src,
                        "action": if it.replaces.is_some() { "optimize" } else { "add" },
                        "replaces": it.replaces,
                    })
                })
                .collect();
            emit(&serde_json::json!({
                "applied": apply,
                "curated": items.len(),
                "plan": items,
                "skippedRetired": retired,
            }))
        }
        // `refolder` (#4107) — re-derive every stored impl's `folder` from its `src`, mirroring
        // `bsc ui regroup`. The backfill for a library curated before the folder existed: `src` has
        // ridden along since #4091, so most records can be placed without a re-harvest. Idempotent —
        // `folder_from_src` is a fixed point on an already-clean path, so only records that actually
        // MOVED are rewritten, and a re-run reports zero.
        "refolder" => {
            let mut g = crate::load();
            let mut moved = Vec::new();
            let mut srcless = 0usize;
            for im in crate::implementations_of(&g) {
                let Some(src) = im.get("src").and_then(Value::as_str).filter(|s| !s.trim().is_empty())
                else {
                    // No provenance ⇒ nothing to derive from. Counted, not guessed at: inventing a
                    // folder here is exactly the curated-taxonomy step this deliberately defers.
                    srcless += 1;
                    continue;
                };
                let next_folder = bsc_util::folder_from_src(src);
                let cur = im.get("folder").and_then(Value::as_str);
                if cur == next_folder.as_deref() {
                    continue;
                }
                let id = im.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                let mut next = im.clone();
                match &next_folder {
                    Some(f) => next["folder"] = Value::String(f.clone()),
                    None => {
                        next.as_object_mut().map(|o| o.remove("folder"));
                    }
                }
                crate::set_impl(&mut g, next)?;
                moved.push(serde_json::json!({ "id": id, "from": cur, "to": next_folder }));
            }
            if !moved.is_empty() {
                crate::save(&g)?;
            }
            emit(&serde_json::json!({ "moved": moved.len(), "srcless": srcless, "changes": moved }))
        }
        // `relink <dir>` (#4119) — recover `src` on impls curated before provenance existed, by matching
        // them against a fresh harvest of `<dir>`.
        //
        // This is the PREREQUISITE `refolder` is blocked on: `folder` derives from `src`, so an impl
        // without one is `srcless` and skipped, which is why a library curated before #4091 has no tree
        // at all rather than a stale one.
        //
        // AMBIGUITY IS NEVER GUESSED. A candidate id is `<kebab(name)>.<ext>`, and bare function names
        // collide freely across a real tree (`dismiss.ts`, `approve.ts`, `app.ts` all recur) — which is
        // exactly why the id cannot serve as identity and why `src` is needed in the first place. An id
        // matching more than one harvested file is reported and skipped; picking one would write a
        // provenance that is plausibly wrong, which is worse than none.
        //
        // Idempotent: an impl that already carries `src` is left alone, so a re-run reports zero.
        "relink" => {
            let dir = positional
                .get(1)
                .ok_or("usage: bsc graph relink <dir> [--tech typescript|rust] [--dry-run] [--pretty]")?;
            let tech = flag_value(&args, "--tech");
            let dry = args.iter().any(|a| a == "--dry-run");

            // id -> the distinct srcs harvested under it. More than one ⇒ ambiguous.
            let mut by_id: std::collections::BTreeMap<String, std::collections::BTreeSet<String>> =
                std::collections::BTreeMap::new();
            for c in crate::extract::harvest(std::path::Path::new(dir)) {
                if tech.as_deref().is_some_and(|t| c.tech != t) {
                    continue;
                }
                if !c.src.trim().is_empty() {
                    by_id.entry(c.id).or_default().insert(c.src);
                }
            }

            let mut g = crate::load();
            let stored = crate::implementations_of(&g);
            let plan = crate::extract::relink_plan(&stored, &by_id);

            let by_stored_id: std::collections::BTreeMap<&str, &Value> = stored
                .iter()
                .map(|im| (im.get("id").and_then(Value::as_str).unwrap_or(""), im))
                .collect();
            let (mut linked, mut ambiguous, mut unmatched, mut had_src) = (Vec::new(), Vec::new(), 0usize, 0usize);
            let mut primitives = 0usize;
            for outcome in &plan {
                match outcome {
                    crate::extract::RelinkOutcome::Primitive { .. } => primitives += 1,
                    crate::extract::RelinkOutcome::AlreadyLinked { .. } => had_src += 1,
                    crate::extract::RelinkOutcome::Unmatched { .. } => unmatched += 1,
                    crate::extract::RelinkOutcome::Ambiguous { id, candidates } => {
                        ambiguous.push(serde_json::json!({ "id": id, "candidates": candidates }));
                    }
                    crate::extract::RelinkOutcome::Link { id, src, folder } => {
                        if !dry {
                            let Some(im) = by_stored_id.get(id.as_str()) else { continue };
                            let mut next = (*im).clone();
                            next["src"] = Value::String(src.clone());
                            // Derive the folder in the same breath, through the SAME shared helper the
                            // component library uses — so recovering provenance places the record in one
                            // pass rather than needing a `refolder` chaser.
                            if let Some(f) = folder {
                                next["folder"] = Value::String(f.clone());
                            }
                            crate::set_impl(&mut g, next)?;
                        }
                        linked.push(serde_json::json!({ "id": id, "src": src, "folder": folder }));
                    }
                }
            }
            if !dry && !linked.is_empty() {
                crate::save(&g)?;
            }
            emit(&serde_json::json!({
                "dryRun": dry,
                "linked": linked.len(),
                "ambiguous": ambiguous.len(),
                "unmatched": unmatched,
                "alreadyLinked": had_src,
                // Counted separately, never as a miss: a primitive has no source BY DESIGN (#2972).
                "primitives": primitives,
                "changes": linked,
                "ambiguousIds": ambiguous,
            }))
        }
        // `tests harvest <dir>` (#4126) — carry each impl's COLOCATED test file onto its node, the
        // algorithms twin of `bsc ui tests harvest` (#3907), pairing through the SAME
        // `bsc_util::test_path_for` so the two libraries cannot drift.
        //
        // MIRROR, not source. The files stay authoritative, checked in, and RUNNING. The graph cannot
        // execute a test today, so making it the source would stake the suite on an executor that does
        // not exist — a node's `tests` entry is inert metadata until `verify` lands (#4124). This buys
        // doctor honesty and a queryable graph at zero risk to coverage.
        //
        // ONE ENTRY PER FILE, VERBATIM. A test file's meaning lives partly outside its `it()` blocks —
        // imports, `beforeEach`, local helpers. Splitting per-`it` would silently drop that. A file that
        // covers SEVERAL impls (this repo's `graphAlgos.test.ts` covers five) is carried onto each of
        // them: the coverage is real for every one, and per-impl attribution is not recoverable from the
        // file.
        //
        // TypeScript only. A Rust impl's tests are an inline `#[cfg(test)] mod tests`, not a sibling
        // file, so path-pairing would report every Rust impl untested — see `bsc_util::test_path_for`.
        "tests" => {
            if positional.get(1).copied() != Some("harvest") {
                return Err("usage: bsc graph tests harvest <dir> [--id a,b] [--dry-run] [--pretty]".to_string());
            }
            let dir = positional
                .get(2)
                .ok_or("usage: bsc graph tests harvest <dir> [--id a,b] [--dry-run] [--pretty]")?;
            let dry = args.iter().any(|a| a == "--dry-run");
            // #123 — SCOPED to named ids, so pairing one record does not rewrite every other impl that
            // happens to share the harvest's colocated-test pass. Absent, the whole store is walked, as
            // before.
            let ids: Option<std::collections::HashSet<String>> = flag_value(&args, "--id").map(|s| {
                s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
            });
            let root = std::path::Path::new(dir);
            if !root.is_dir() {
                return Err(format!("no such directory: {dir}"));
            }
            // A harvest hands back file CONTENTS, so it honours the same boundary the file tools do
            // (#3475) — `bsc-confine` is blind to what this binary reads.
            bsc_cli_util::require_harvestable_root(root)?;

            let mut g = crate::load();
            let impls: Vec<Value> = crate::implementations_of(&g)
                .into_iter()
                .filter(|im| {
                    ids.as_ref().is_none_or(|ids| {
                        im.get("id").and_then(Value::as_str).is_some_and(|id| ids.contains(id))
                    })
                })
                .collect();

            // ⚠️ A WRONG ROOT LOOKS EXACTLY LIKE AN UNTESTED LIBRARY. Every `src` is repo-relative and
            // already begins `src/`, so the root to pass is the REPO root. Handed `src` instead, every
            // join becomes `src/src/…`, nothing resolves, and the command still exits 0 reporting a
            // plausible `paired: 31 · noColocatedTest: 876` — which reads as "the algorithm tier has no
            // tests" and was filed as exactly that before anyone checked the invocation. The signature is
            // deterministic (the root's own name is the first segment of the sources), so detect it and
            // refuse rather than return a number that means nothing.
            let root_name =
                root.canonicalize().ok().and_then(|p| p.file_name().map(|s| s.to_string_lossy().into_owned()));
            let srcs: Vec<&str> = impls
                .iter()
                .filter_map(|im| im.get("src").and_then(Value::as_str))
                .filter(|s| !s.trim().is_empty())
                .collect();
            if let Some(name) = root_name.filter(|n| root_doubles_source_prefix(n, &srcs)) {
                return Err(format!(
                    "every source path already starts with '{name}/', so joining them to this root gives \
                     '{name}/{name}/…' and nothing resolves — pass the REPO root, not '{name}'"
                ));
            }

            let (mut paired, mut no_src, mut no_test, mut retired_no_test) =
                (Vec::new(), 0usize, 0usize, 0usize);
            for im in impls {
                let Some(src) = im.get("src").and_then(Value::as_str).filter(|s| !s.trim().is_empty())
                else {
                    // No provenance ⇒ nothing to pair against. `relink` (#4119) is the fix, not a guess.
                    no_src += 1;
                    continue;
                };
                // Whether the MODULE still exists separates "a live file nobody tested" from "a retired
                // module whose test went with it". Both used to land in `noColocatedTest`, where the
                // second is invisible — and the second is the one the migration can still act on.
                let module_gone = !root.join(src).is_file();
                let Some(path) = bsc_util::test_path_for(root, src) else {
                    if module_gone {
                        retired_no_test += 1;
                    } else {
                        no_test += 1;
                    }
                    continue;
                };
                let Ok(contents) = std::fs::read_to_string(&path) else {
                    if module_gone {
                        retired_no_test += 1;
                    } else {
                        no_test += 1;
                    }
                    continue;
                };
                let id = im.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                let name = bsc_util::test_display_name(&path, &contents);
                let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
                if !dry {
                    let mut next = im.clone();
                    next["tests"] = serde_json::json!([{ "name": name, "src": contents }]);
                    crate::set_impl(&mut g, next)?;
                }
                paired.push(serde_json::json!({ "id": id, "name": name, "test": rel }));
            }
            if !dry && !paired.is_empty() {
                crate::save(&g)?;
            }

            // ONE TEST FILE, N IMPLS — reported, never silent. A module exporting several functions
            // yields one impl each, and they all pair with that module's single test file. Carrying it
            // onto each is right for the MIRROR (the coverage really is theirs, and per-impl attribution
            // is not recoverable from the file) and is a trap for any EXECUTOR that materializes one file
            // per record: the same assertions would run N times and be counted N times. Whoever consumes
            // this has to know which pairings are shared, so say so instead of leaving it to be discovered.
            let (distinct_tests, shared) = shared_test_pairings(&paired);
            let shared_impls: usize = shared
                .iter()
                .map(|s| s.get("impls").and_then(Value::as_array).map_or(0, Vec::len))
                .sum();

            emit(&serde_json::json!({
                "dryRun": dry,
                "paired": paired.len(),
                "noSrc": no_src,
                "noColocatedTest": no_test,
                "retiredNoTest": retired_no_test,
                "distinctTests": distinct_tests,
                "sharedTestFiles": shared.len(),
                "sharedTestImpls": shared_impls,
                "shared": shared,
                "changes": paired,
            }))
        }
        // `promote [--id a,b] [--check] [--root <dir>]` — move records from the per-user RUNTIME store
        // into the committed, build-readable repo store, or (with `--check`) report the drift for the
        // gate. See `crate::repo_store` for why the two stores exist and why the repo one is read
        // directly rather than through `load()`.
        // The crate migration is a VERB, not a script (`record-operations-belong-on-the-bsc-surface-
        // not-in-scripts`): `bsc` is the mandatory permission tier every role can auto-run, while
        // `node scripts/…` needs the build tier the sessions that should drive a migration rarely hold.
        // The logic lives in `migrate` — this arm is only the seam.
        "migrate-crate" => {
            let rest: Vec<String> = args.iter().skip(1).cloned().collect();
            crate::migrate::run(&rest, &mut std::io::stdout())
        }
        "promote" => {
            let check = args.iter().any(|a| a == "--check");
            // TWO TARGETS, ONE VERB. `graph/algorithms.json` is what the BUILD compiles; the packaged
            // seed is what SHIPS and what a fresh install reconciles against. Same source store, same
            // machinery, different destination and a narrower projection — so `--seed` is a flag here
            // rather than a second verb that would drift out of step with this one.
            let to_seed = args.iter().any(|a| a == "--seed");
            let root = flag_value(&args, "--root")
                .map(std::path::PathBuf::from)
                .unwrap_or(std::env::current_dir().map_err(|e| format!("cannot resolve cwd: {e}"))?);
            let path = if to_seed {
                crate::repo_store::seed_path_under(&root)
            } else {
                crate::repo_store::path_under(&root)
            };
            let project: fn(&serde_json::Value) -> serde_json::Value = if to_seed {
                crate::repo_store::seed_content_of
            } else {
                crate::repo_store::content_of
            };
            let repo = crate::repo_store::read_at(&path)?.unwrap_or_else(crate::repo_store::empty);
            let runtime = crate::implementations_of(&crate::load());

            // No `--id` means "refresh what this store already tracks". A bare promote must never
            // ADOPT new records by itself — what the build compiles is an explicit decision.
            let ids: Vec<String> = match flag_value(&args, "--id") {
                Some(s) => s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect(),
                None => crate::repo_store::tracked_ids(&repo),
            };

            if check {
                // THE CHECK READS THE RUNTIME STORE DIRECTLY, and this is what makes it usable as a
                // gate. `load()` reconciles the packaged seed and falls back to it entirely when no
                // store file exists — so on a fresh clone, in CI, or in any worktree that is not the
                // AUTHORING machine, the comparison silently becomes "repo store vs the seed" and
                // reports drift for records that are perfectly current. Measured before this fix: a
                // machine with no runtime store reported 2 drifted + 1 missing and exited 1.
                //
                // The write path below deliberately keeps `load()`: ADOPTING a record may legitimately
                // pull one that exists only in the packaged seed. Only the check is narrowed, because
                // only the check has to hold on every machine.
                let Some(direct) = crate::store_path().map(|p| crate::repo_store::read_at(&p)).transpose()?.flatten()
                else {
                    return emit(&serde_json::json!({
                        "checked": 0, "drifted": [], "ok": true, "store": path.to_string_lossy(),
                        "note": "no runtime store on this machine — nothing was authored here to compare against",
                    }));
                };
                // Compare through the SAME projection the write would use, or every seed record reads
                // as drifted for carrying fields the seed never ships.
                let upstream: Vec<serde_json::Value> =
                    crate::repo_store::impls_of(&direct).iter().map(project).collect();
                let repo_impls: Vec<serde_json::Value> =
                    crate::repo_store::impls_of(&repo).iter().map(project).collect();
                let mut differs = Vec::new();
                let mut absent = Vec::new();
                let mut behind = Vec::new();
                for id in &ids {
                    match crate::repo_store::verdict_for(&upstream, &repo_impls, id) {
                        crate::repo_store::Verdict::Differs => differs.push(id.clone()),
                        // NOT a failure. A machine whose runtime store lacks the record has no opinion
                        // about whether the committed one is stale, and failing here would redden the
                        // gate for every agent who simply never authored it.
                        crate::repo_store::Verdict::MissingUpstream => absent.push(id.clone()),
                        // The runtime store REGRESSED — same code, fewer fields. Nothing to promote, and
                        // promoting would delete what the committed copy has. Reported, never a failure.
                        crate::repo_store::Verdict::RuntimeBehind => behind.push(id.clone()),
                        crate::repo_store::Verdict::UpToDate => {}
                    }
                }
                emit(&serde_json::json!({
                    "checked": ids.len(), "drifted": differs, "notAuthoredHere": absent,
                    "runtimeBehind": behind,
                    "store": path.to_string_lossy(), "ok": differs.is_empty(),
                }))?;
                // A gate that cannot fail is not a gate. Naming the ids is the whole point: the
                // failure mode this guards is an edit that never reached what the compiler reads.
                if !differs.is_empty() {
                    return Err(format!(
                        "the {} is out of date — {} drifted ({}). \
                         Run `bsc graph promote{}` to bring it forward.",
                        if to_seed { "packaged seed" } else { "repo store" },
                        differs.len(),
                        differs.join(", "),
                        if to_seed { " --seed" } else { "" },
                    ));
                }
                return Ok(());
            }

            let repo_impls = crate::repo_store::impls_of(&repo);
            let mut missing = Vec::new();
            for id in &ids {
                if crate::repo_store::verdict_for(&runtime, &repo_impls, id)
                    == crate::repo_store::Verdict::MissingUpstream
                {
                    missing.push(id.clone());
                }
            }

            // NOTHING TO PROMOTE MUST TOUCH NOTHING. A bare `promote` in a repo that tracks no records
            // used to create an empty store wherever the cwd happened to be — which is exactly what it
            // did inside `crates/bsc-graph/` when `verbs_match_the_dispatcher` invoked every verb. A
            // read-shaped no-op that writes a file into the source tree is a side effect nobody asked
            // for, so it now reports and returns.
            if ids.is_empty() {
                return emit(&serde_json::json!({
                    "ok": true, "store": path.to_string_lossy(), "promoted": 0, "tracked": 0,
                    "note": "this repo store tracks no records yet — adopt one with `--id <id>`",
                }));
            }

            let (mut next, missing, refused) =
                crate::repo_store::promote_into_with(&repo, &runtime, &ids, project);
            // Only the seed carries the referential-integrity guard that rejects a dangling `composes`.
            let pruned = if to_seed {
                crate::repo_store::prune_dangling_composes(&mut next)
            } else {
                Vec::new()
            };

            // WHAT STILL NAMES A SPECIFIER — gathered from both graphs, because an impl's provider is
            // routinely imported by a COMPONENT record and a components-only view would miss it.
            let mut imported: std::collections::BTreeSet<String> = Default::default();
            if to_seed {
                for i in crate::repo_store::impls_of(&next) {
                    if let Some(c) = i.get("code").and_then(serde_json::Value::as_str) {
                        crate::repo_store::quoted_specifiers(c, &mut imported);
                    }
                }
                let comps = root.join("src-tauri/data/components/app");
                let mut stack = vec![comps];
                while let Some(d) = stack.pop() {
                    let Ok(rd) = std::fs::read_dir(&d) else { continue };
                    for e in rd.flatten() {
                        let p = e.path();
                        if p.is_dir() {
                            stack.push(p);
                        } else if p.extension().is_some_and(|x| x == "json") {
                            if let Some(t) = std::fs::read_to_string(&p).ok().and_then(|t| {
                                serde_json::from_str::<serde_json::Value>(&t).ok()
                            }) {
                                if let Some(src) = t.get("srcText").and_then(serde_json::Value::as_str) {
                                    crate::repo_store::quoted_specifiers(src, &mut imported);
                                }
                            }
                        }
                    }
                }
            }
            let orphaned = if to_seed {
                crate::repo_store::refuse_orphaning_promotions(&repo, &mut next, &imported)
            } else {
                Vec::new()
            };
            let next = next;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
            }
            let body = serde_json::to_string_pretty(&next)
                .map_err(|e| format!("cannot render the repo store: {e}"))?;
            std::fs::write(&path, format!("{body}\n"))
                .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
            emit(&serde_json::json!({
                "ok": true, "store": path.to_string_lossy(),
                "promoted": ids.len() - missing.len() - refused.len(), "missingUpstream": missing,
                // REFUSED, not skipped: the runtime copy is a subset of the committed one, so writing it
                // would delete fields. Named so a caller sees a decision rather than a silent no-op.
                "refusedWouldLoseFields": refused,
                "tracked": crate::repo_store::tracked_ids(&next).len(),
                // Reported, never silent: a pruned edge is a claim the record made that the graph
                // could not honour, and the author should see which.
                "prunedComposes": pruned.iter().map(|(id, gone)| {
                    serde_json::json!({ "id": id, "dropped": gone })
                }).collect::<Vec<_>>(),
                // Held back because promoting would have stopped a specifier something still imports
                // from resolving — the store being behind the seed on a move.
                "declined": orphaned.iter().map(|(id, spec)| {
                    serde_json::json!({ "id": id, "wouldOrphan": spec })
                }).collect::<Vec<_>>(),
            }))
        }
        // `build [<id>|--all] [--wasm] [--force]` — compile a Tier-R node and STAMP the verdict onto it,
        // so `impl get` answers "does this compile?" without running anything. See `crate::build_facet`.
        "build" => {
            let all = args.iter().any(|a| a == "--all");
            let want_wasm = args.iter().any(|a| a == "--wasm");
            let force = args.iter().any(|a| a == "--force");
            let mut g = crate::load();
            let impls = crate::implementations_of(&g);

            let materialized = materialized_crates();
            let mut tier_a = Vec::new();
            let ids: Vec<String> = if all {
                impls
                    .iter()
                    .filter(|i| {
                        i.get("tech").and_then(Value::as_str) == Some("rust")
                            && i.get("role").and_then(Value::as_str) == Some("algorithm")
                            && i.get("code").and_then(Value::as_str).is_some_and(|c| !c.trim().is_empty())
                    })
                    // Tier A compiles inside its crate, never standalone. Excluded rather than failed —
                    // and COUNTED, because a skip nobody is told about reads as a record that was checked.
                    .filter(|i| {
                        let is_a = crate::build_facet::is_tier_a(i.get("src").and_then(Value::as_str), &materialized);
                        if is_a {
                            if let Some(id) = i.get("id").and_then(Value::as_str) {
                                tier_a.push(id.to_string());
                            }
                        }
                        !is_a
                    })
                    .filter_map(|i| i.get("id").and_then(Value::as_str).map(str::to_string))
                    .collect()
            } else {
                vec![positional.get(1).ok_or("usage: bsc graph build <id> | build --all [--wasm]")?.to_string()]
            };

            let toolchain = rustc_version();
            let refs: Vec<&Value> = impls.iter().collect();
            let mut results = Vec::new();
            let mut built = 0usize;
            let mut cached = 0usize;
            let mut failed = 0usize;

            for id in &ids {
                let Some(node) = impls.iter().find(|i| i.get("id").and_then(Value::as_str) == Some(id.as_str()))
                else {
                    return Err(format!("no implementation '{id}'"));
                };
                let closure = crate::rust_test::closure_of(&refs, id);
                let source = crate::rust_test::materialize(&closure, &[]);
                let hash = crate::build_facet::facet_hash(&source, &toolchain, crate::build_facet::WASM_FLAGS);

                // A matching hash is not enough on its own: the artifact is a CACHE and may have been
                // swept. Re-derive rather than trust a verdict whose output is gone.
                if !force && crate::build_facet::is_current(node, &hash) && artifacts_present(node) {
                    cached += 1;
                    results.push(serde_json::json!({ "id": id, "state": "cached", "hash": hash }));
                    continue;
                }

                let outcome = build_one(id, &source, want_wasm, &hash)?;
                let ok = outcome.iter().all(|t| t.passed);
                if ok { built += 1 } else { failed += 1 }
                let at = bsc_util::epoch_ms_to_iso8601(bsc_util::now_secs() * 1000);
                let facet = crate::build_facet::facet(&hash, &toolchain, &at, &outcome);
                stamp_build(&mut g, id, facet.clone());
                results.push(serde_json::json!({ "id": id, "state": if ok { "built" } else { "failed" }, "build": facet }));
            }

            if let Some(p) = crate::store_path() {
                crate::save_at(&p, &g)?;
            }
            emit(&serde_json::json!({
                "built": built, "cached": cached, "failed": failed,
                "tierA": tier_a, "results": results,
            }))?;
            // A runner nothing can fail is not a gate.
            if failed > 0 {
                return Err(format!("{failed} node(s) failed to build"));
            }
            Ok(())
        }
        // `dump` — the whole graph document (the `implementations` tier), store-or-seed.
        "dump" => emit(&crate::load()),
        // `doctor [--fix]` (#3212) — diagnose the library's visualization typing + coverage: untyped /
        // invalid-kind / mistyped / missing-viz. `--fix` assigns the heuristic kind to UNTYPED-but-
        // classifiable impls (never overwriting an assigned kind), then re-diagnoses.
        "doctor" => {
            let fix = args.iter().any(|a| a == "--fix");
            let mut g = crate::load();
            // #78 — a FOCUSED mode, not another section bolted onto the default report. The default
            // doctor already emits well over a thousand findings on the real store; folding duplicate
            // groups into that would bury them exactly the way #74's pairs buried theirs.
            if args.iter().any(|a| a == "--dedup") {
                let groups = dedup_findings(&g);
                return emit(&serde_json::json!({ "duplicates": groups, "count": groups.len() }));
            }
            if fix {
                let mut fixed = Vec::new();
                for im in crate::implementations_of(&g) {
                    if im.get("role").and_then(Value::as_str) != Some("algorithm") {
                        continue;
                    }
                    if im.get("kind").and_then(Value::as_str).is_none() {
                        if let Some(k) = crate::classify_kind(&im) {
                            let id = im.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                            let mut next = im.clone();
                            next["kind"] = Value::String(k.to_string());
                            crate::set_impl(&mut g, next)?;
                            fixed.push(serde_json::json!({ "id": id, "kind": k }));
                        }
                    }
                }
                if !fixed.is_empty() {
                    crate::save(&g)?;
                }
                let remaining = crate::doctor_with_entities(&g, &entity_ids());
                emit(&serde_json::json!({ "fixed": fixed, "remaining": remaining, "remaining_count": remaining.len() }))
            } else {
                let findings = crate::doctor_with_entities(&g, &entity_ids());
                // EDGE COVERAGE (integration-tests-become-graph-edges). `composes` says A builds on B;
                // an edge says someone CHECKED. Reporting the gap makes coverage a property of the
                // graph rather than of a file tree — the first question the node tier could never ask.
                let (missing_edges, dangling_edges, pending_edges) = crate::edge_findings(&g);
                // #doctor-reads-the-runtime — the RUNTIME lens, behind `--runtime`. For an implementation
                // the claim is LINKAGE: an impl runs inside someone else's module, so "was it linked into
                // a closure that served" is what the runtime can honestly say. Execution counts are NOT
                // asserted here and the report does not imply them.
                let runtime = if args.iter().any(|a| a == "--runtime") {
                    runtime_report(&g)
                } else {
                    serde_json::Value::Null
                };
                emit(&serde_json::json!({
                    "findings": findings,
                    "count": findings.len(),
                    "runtime": runtime,
                    "missingEdges": missing_edges,
                    "missingEdgeCount": missing_edges.len(),
                    // Separate, and worse: a MISSING edge is honestly empty, a DANGLING one reads as
                    // covered while naming a record that is gone.
                    "danglingEdges": dangling_edges,
                    // PENDING is not a defect: an edge written at retirement names collaborators that
                    // are still files, and they resolve as the migration reaches them.
                    "pendingEdges": pending_edges,
                }))
            }
        }
        // `emit` (#4192) — the store→FILE direction, the twin of `bsc ui emit`. The graph is the source
        // of truth and a file is the artifact, so maintenance edits the record then re-emits.
        "runtime-lens-marker-unused" => unreachable!(),
        "emit" => {
            let sub = positional.get(1).copied();
            match sub {
                Some("impl") => {
                    let id = positional.get(2).ok_or("usage: bsc graph emit impl <id> <dir>")?;
                    let dir = positional.get(3).ok_or("usage: bsc graph emit impl <id> <dir>")?;
                    let plan = crate::emit::plan_one(&crate::load(), id)?;
                    write_emit_plan(&plan, dir, emit)
                }
                Some("all") => {
                    let dir = positional.get(2).ok_or("usage: bsc graph emit all <dir>")?;
                    let plan = crate::emit::plan_all(&crate::load());
                    write_emit_plan(&plan, dir, emit)
                }
                Some("sync") => {
                    let dir = positional.get(2).ok_or("usage: bsc graph emit sync <dir>")?;
                    emit_sync(dir, emit)
                }
                Some("help") | None => {
                    print!("{}", help(prog));
                    Ok(())
                }
                Some(other) => Err(format!(
                    "unknown emit command '{other}' — want: impl <id> <dir> | all <dir> | sync <dir>"
                )),
            }
        }
        // `used-by <id>` / `--all` (#3594) — the composes-inverse USAGE read (measure step of the optimize
        // loop; mirrors `bsc ui used-by`). A read.
        "used-by" => {
            let g = crate::load();
            let idx = crate::used_by_index(&g);
            if args.iter().any(|a| a == "--all") {
                let mut rows: Vec<Value> = crate::implementations_of(&g)
                    .iter()
                    .map(|im| {
                        let id = im.get("id").and_then(Value::as_str).unwrap_or("");
                        serde_json::json!({
                            "id": id,
                            "name": im.get("name").and_then(Value::as_str).unwrap_or(""),
                            "tech": im.get("tech").and_then(Value::as_str).unwrap_or(""),
                            "count": idx.get(id).map_or(0, Vec::len),
                        })
                    })
                    .collect();
                rows.sort_by(|a, b| {
                    b["count"].as_u64().cmp(&a["count"].as_u64()).then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
                });
                emit(&Value::Array(rows))
            } else {
                let id = positional.get(1).copied().ok_or("usage: bsc graph used-by <id>  |  bsc graph used-by --all")?;
                if !crate::implementations_of(&g).iter().any(|im| im.get("id").and_then(Value::as_str) == Some(id)) {
                    return Err(format!("unknown implementation '{id}'"));
                }
                let composers = idx.get(id).cloned().unwrap_or_default();
                emit(&serde_json::json!({ "id": id, "usedBy": composers, "count": composers.len() }))
            }
        }
        // `merge <from-id> <into-id>` (#3594) — the combine ACT (mirrors `bsc ui merge`): repoint every
        // impl's `composes` from→into, then remove `from`.
        "merge" => {
            let from = positional.get(1).copied().ok_or("usage: bsc graph merge <from-id> <into-id>")?;
            let into = positional.get(2).copied().ok_or("usage: bsc graph merge <from-id> <into-id> — the survivor id is required")?;
            let mut g = crate::load();
            let repointed = crate::merge_impls(&mut g, from, into)?;
            crate::save(&g)?;
            emit(&serde_json::json!({ "from": from, "into": into, "repointed": repointed, "removed": from }))
        }
        "help" | "-h" | "--help" => {
            print!("{}", help(prog));
            Ok(())
        }
        other => Err(format!("unknown graph command '{other}' — read: impl list | dump | harvest <dir> | curate <dir> | doctor | used-by; write: impl set | impl remove | merge\n\n{}", help(prog))),
    }
}

/// The value following a `--flag`, if present.
/// Has an `impl set` DECLARED where its code comes from (#4136)?
///
/// An `algorithm` must carry `src` (the folder derives from it), a `folder`, or an explicit `--no-src`
/// for a canonical algorithm with no file in this repo. Absence must be stated rather than defaulted:
/// the librarian curated 10 algorithms through this verb with none, so none could sit in the folder tree
/// the rail organizes by, and nothing surfaced the omission.
///
/// A `primitive` is exempt BY DESIGN — it DESCRIBES a language built-in via `--ref` and is never
/// re-coded (#2972), so it has no source to point at. Pure, so the rule is testable without touching the
/// store (which `run` would otherwise write for real).
/// Will the record carry provenance AFTER this write lands (#4136, corrected #4154)?
///
/// Considers the STORED record, not just the flags — the gate used to see only `im`, so a routine
/// `--domain` edit on a record that already had `src` was refused unless provenance was restated.
///
/// A `--clear`ed field arrives as JSON `null`, which counts as ABSENT: clearing an algorithm's only
/// provenance must FAIL the gate, not satisfy it by virtue of the key being present.
fn provenance_declared(role: &str, im: &Value, stored: Option<&Value>, no_src: bool) -> bool {
    if role != "algorithm" || no_src {
        return true; // a primitive DESCRIBES a built-in via `--ref` (#2972); `--no-src` is the explicit none
    }
    ["src", "folder"].iter().any(|k| match im.get(*k) {
        Some(Value::Null) => false,                                   // explicitly cleared by this write
        Some(_) => true,                                              // supplied by this write
        None => stored.and_then(|s| s.get(*k)).is_some_and(|v| !v.is_null()), // already on the record
    })
}

/// Refuse an unknown `--flag` instead of ignoring it (#4154, designer request #52).
///
/// The designer passed `--tests <content>` — a flag this CLI has never had — got NO error, then read the
/// record back and found no `tests` field. The reasonable conclusion was "the write dropped it", and that
/// reading is what kept a fixed merge looking broken across three probes. Silence is the bug: a flag that
/// does nothing must say so, because the alternative is the caller inferring a data-loss bug from it.
///
/// Walks the argv rather than scanning for `--`, so a VALUE that happens to start with `--`
/// (`--summary "--foo"`) is not mistaken for a flag.
fn reject_unknown_flags(args: &[String]) -> Result<(), String> {
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if let Some(stripped) = a.strip_prefix("--") {
            if !FLAGS.contains(&a.as_str()) {
                let near: Vec<&str> = FLAGS
                    .iter()
                    .copied()
                    .filter(|f| f.contains(stripped) || stripped.contains(f.trim_start_matches("--")))
                    .collect();
                return Err(format!(
                    "unknown flag '{a}'{}

run `bsc graph help` for the flags this CLI reads.",
                    if near.is_empty() { String::new() } else { format!(" — did you mean {}?", near.join(" | ")) },
                ));
            }
            // A value-taking flag consumes the next token, which must not be re-read as a flag.
            if !BOOL_FLAGS.contains(&a.as_str()) {
                i += 1;
            }
        }
        i += 1;
    }
    Ok(())
}

fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}

/// Resolve a SOURCE-bearing flag from either its inline form (`--code`) or its file form
/// (`--code-file`), reading the file verbatim (#76, designer request).
///
/// Source on the command line does not survive the shell, and it fails SILENTLY in both directions:
/// a literal `\n` stays two characters inside a double-quoted bash argument, and a backtick or a
/// `${…}` is COMMAND-SUBSTITUTED before the binary ever sees it — so the record is written, just not
/// with the code that was meant. Nothing downstream can detect that, because the value that arrived
/// is perfectly well-formed. This repo has already lost content to exactly that (four `bsc plan`
/// notes), and the standing workaround was to rewrite the source to avoid backticks and newlines —
/// i.e. to change the code being stored to suit its transport.
///
/// `edge set --src` already reads from disk for the same reason, and `harvest --module --apply`
/// exists because two modules (71 KB and 42 KB) are past the Windows `CreateProcess` argv limit and
/// could not be written at all. This gives `impl set` the same door.
///
/// Both forms at once is an ERROR rather than a precedence rule: whichever way it resolved, the
/// caller believed the other one was being stored.
fn source_flag(args: &[String], flag: &str) -> Result<Option<String>, String> {
    let file_flag = format!("{flag}-file");
    match (flag_value(args, flag), flag_value(args, &file_flag)) {
        (Some(_), Some(_)) => {
            Err(format!("{flag} and {file_flag} were both given — pass one, not both"))
        }
        (Some(v), None) => Ok(Some(v)),
        (None, Some(p)) => {
            let path = std::path::Path::new(&p);
            // #3475: reading file CONTENTS through an allow-listed CLI must honor the same boundary
            // the file tools do, or a confined session reads any path on disk through this verb.
            // Outside a confined session this is a no-op, so it costs the ordinary caller nothing.
            bsc_cli_util::require_harvestable_root(path)?;
            // An unreadable path is an ERROR, never an empty field: silently storing "" would erase
            // the record's source, which is the very corruption this flag exists to prevent.
            let contents =
                std::fs::read_to_string(path).map_err(|err| format!("cannot read {p}: {err}"))?;
            // …AND SO IS AN EMPTY ONE, which the guard above misses because a 0-byte file reads fine.
            // That gap erased a record: a script truncated its output file with `open(…, "w")` and then
            // threw before writing, so `--code-file` stored an empty body over a 6,234-character module
            // and it was promoted into the committed store before anything noticed. Writing nothing is
            // never what a caller means by "set the code from this file".
            if contents.trim().is_empty() {
                return Err(format!(
                    "{p} is empty — refusing to store an empty body. If you meant to clear the field, \
                     say so explicitly with `--clear {}`.",
                    flag.trim_start_matches("--")
                ));
            }
            Ok(Some(contents))
        }
        (None, None) => Ok(None),
    }
}

/// A BATCH write skips a retired id and records it, instead of aborting the whole run (#77).
///
/// `set_impl` now refuses a suppressed id, which is right for `impl set` — the caller named that one
/// id and deserves to be told no. A batch is different: harvest and curate walk a TREE, and a retired
/// module's FILE is usually still on disk (retirement is a decision about the store, not the source),
/// so re-encountering it is the expected case rather than an exceptional one. Aborting would mean one
/// retired module stops an otherwise good harvest of forty.
///
/// Skipped ids are RETURNED, never swallowed: a silent skip is how the caller ends up believing a
/// record was written when it was not — the same class of quiet wrongness as the resurrection itself.
fn set_impl_skipping_retired(g: &mut Value, im: Value, skipped: &mut Vec<String>) -> Result<(), String> {
    let id = im.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    if !id.is_empty() && crate::is_suppressed(g, &id) {
        skipped.push(id);
        return Ok(());
    }
    crate::set_impl(g, im).map(|_| ())
}

/// Split a `--flag a,b,c` value into a JSON string array (empty when absent/blank) — for `--composes`
/// on `impl set` (#2863).
fn list_flag(s: Option<&str>) -> Value {
    Value::Array(
        s.unwrap_or("")
            .split(',')
            .map(str::trim)
            .filter(|x| !x.is_empty())
            .map(|x| Value::String(x.to_string()))
            .collect(),
    )
}

fn help(prog: &str) -> String {
    format!(
        "{prog} — the Algorithms knowledge library (#2761/#2853/#2961) — IMPL-ONLY (a node IS its implementation)\n\n\
         READ:\n  \
         {prog} impl get <id-or-name> | impl list [--tech <t>] [--role r] [--domain <d>]   # a language kit's implementations (#2863); --domain filters to a cross-language collection (#3120); get falls back to a bare NAME when it's unambiguous, else lists the colliding ids (#118)\n  \
         {prog} dump [--pretty]                         # the whole store document (the implementations tier)\n  \
         {prog} harvest <dir-or-file> [--tech T] [--worthy-only] [--module] [--pretty]   # harvest a project's functions into candidate library implementations, each classified worthy vs. glue (#2745); a FILE target harvests just that module (#4161); --module lifts a FILE as ONE module-shaped candidate carrying the `provides` specifier, for making a logic module a record rather than a library function; --apply (module mode only) WRITES that candidate to the store, the only path for a module too large to pass as `impl set --code`\n  \
         {prog} curate <dir> [--tech T] [--apply] [--pretty]          # curate a project's WORTHY candidates into the library — add/optimize; --apply writes the runtime store (#2745)\n  \
         {prog} test <id> --out <dir> [--run] | test --all --out <dir> [--run]   # materialize ONE record + its paired tests into an EMPTY dir and optionally run them there — a pass in a directory holding only the record proves it is self-contained (run-a-records-paired-test-in-isolation)
  \n  {prog} edge set --id <id> --members a,b [--src <test-file>] | edge list | edge get <id> | edge remove <id>   # the RELATIONSHIP tier (integration-tests-become-graph-edges): a test spanning two records is evidence about the EDGE between them, not a property of either node; --src is READ from disk so a large test never has to fit through argv
    {prog} refolder [--pretty]                       # re-derive every impl's FOLDER from its `src` — the backfill mirroring `bsc ui regroup` (#4107)
  \
         {prog} relink <dir> [--tech t] [--dry-run] [--pretty]   # recover `src` (and the folder it derives) by matching stored impls to a fresh harvest (#4119)
  \n         {prog} tests harvest <dir> [--id a,b] [--dry-run] [--pretty]   # carry each impl's COLOCATED test file onto its node — the algorithms twin of `bsc ui tests harvest` (#4126). Bare, walks the WHOLE store; `--id` scopes the pairing to named ids only, so harvesting one record does not re-pair every other impl that happens to share its colocated-test pass (#123)
  \n         {prog} doctor [--fix] [--dedup] [--pretty]             # diagnose viz typing + coverage: untyped / invalid-kind / mistyped / missing-viz; --fix assigns the inferred kind to untyped impls (#3212). --dedup is a FOCUSED mode (#78): duplicate-candidate GROUPS over the impl set, keyed on a shared name, a shared src module (normalized for the src/ prefix), or byte-identical code — N duplicates report as ONE row naming every member and the signal, and it is propose-only (fold with `{prog} merge`)\n  \
         {prog} used-by <id> [--pretty] | used-by --all [--pretty]   # the composes-INVERSE usage: which impls compose <id>, or every impl ranked by usage — the measure step before a merge (#3594)\n\n\
         WRITE (#2853) — curate the store; a read after reflects the write:\n  \
         {prog} impl set --tech <lang> --id <id> --role primitive|algorithm --name <n> [--code <c>] [--ref <std-path>] [--composes a,b] [--summary <s>] [--domain <d>] [--tags a,b] [--kind sort|search|traversal|accumulate] [--viz-code <js>|--viz-code-file <path>] [--code-file <path>] [--src <path>] [--folder <p>] [--provides <spec>] [--module-state a,b] [--module-vis pub|private|pub(crate)] [--module-attrs-file <path>] [--reads e1,e2] [--writes e3] [--no-src] [--clear a,b] [--by <who>] [--note <why>]   # upsert a language-kit impl (#4154: a MERGE — unsupplied fields are PRESERVED, not deleted; --clear removes a field explicitly; --no-src declares an algorithm that genuinely has no file here, #4136) (#2863/#2972); --domain/--tags #3120, --kind #3210 animation type, --viz-code #3218 JS trace-program, --src/--folder #4107 (a `--src` DERIVES the folder), --module-vis/--module-attrs-file record HOW a materialized module is DECLARED (visibility + attributes): a mod declaration carries meaning its body does not, and emitting an unconditional pub mod for a #[cfg]-gated or private module changes the program. --module-state names the module's top-level MUTABLE bindings (sets only; --clear moduleState removes). PREFER --code-file/--viz-code-file (#76): source on the command line is corrupted SILENTLY by the shell — a backtick or a ${{…}} is substituted away and a literal backslash-n never becomes a newline — and large modules exceed the argv limit outright\n  \
         {prog} impl remove <id>                        # delete a USER-MADE implementation + scrub it from every composes (a PACKAGED one is refused - it re-seeds; use `suppress`)
  \
         {prog} impl suppress <id> [--superseded-by <new-id>]   # RETIRE a packaged algorithm durably (#71): a `{{ id, suppressed: true }}` TOMBSTONE occupies the id so the seed reconcile stops re-adding it; --superseded-by records WHAT replaced it, on the tombstone because that is the one record the reconcile never overwrites (a self / missing / already-retired target is REFUSED, not stored)
  \
         {prog} impl unsuppress <id>                    # drop the tombstone so the packaged algorithm re-seeds on the next load (no data loss). REFUSES on a live impl - that goes through `remove`
         {prog} impl history <id>                       # the write log (#72): rev, who, when, what CHANGED and what was DROPPED per write — the same shape as `bsc ui log`, from the same shared stamp
  \
         {prog} impl revert <id> [--to <rev>] [--by <who>]   # restore a previous `code`. Defaults to undoing the last source-moving write; REFUSES rather than landing on a nearer revision when the target has aged past the retained rungs, and names which revisions are still reachable
  \
  \
         {prog} emit impl <id> <dir> | emit all <dir> | emit sync <dir>   # the store→FILE direction (#4192): write a record's code as stamped source; `sync` re-emits MANAGED files and skips hand-edited ones. One record = one file — NEVER written over the shared `src` it was lifted from
           {prog} merge <from-id> <into-id> [--pretty]    # fold a DUPLICATE into a survivor: repoint every impl's composes from→into (deduped), then remove `from` — the combine ACT (#3594)\n\
         {prog} migrate-crate <crate> [--apply] [--root <dir>]   # move ONE crate's source into the graph: harvest each top-level module as a record, record HOW it was declared (visibility + attributes), promote it into the committed store the build reads, then drop the `mod` lines, delete the files and opt the crate into the shared build script — so the crate compiles FROM the graph and its directory holds one file. DRY BY DEFAULT: without --apply it prints the plan and touches nothing, because the write path deletes source. REFUSES up front (naming the cause) for a crate that is already migrated, has nested module directories, declares a module with no matching file, or declares a *_test/*_tests module harvest skips — and VERIFIES with a real build before it finishes\n\n\
         {prog} promote [--id a,b] [--check] [--seed] [--root <dir>]   # move records from the per-user RUNTIME store into the COMMITTED, build-readable repo store at graph/algorithms.json — or, with --seed, into the PACKAGED seed at src-tauri/data/knowledge/algorithms.json (what SHIPS and what a fresh install reconciles against; a record can legitimately be in one and not the other). --seed projects to the 15 fields the seed actually carries, normalises a file EXTENSION found in `tech` (`ts` -> `typescript`), prunes a `composes` target that is not an impl, and DECLINES any record whose promotion would stop a specifier something still imports from resolving — the store a fresh clone, CI and every worktree agent compile from. Bare `promote` refreshes only what the store already TRACKS; `--id` adopts new records, because what the build compiles is an explicit decision. `--check` writes nothing and EXITS NON-ZERO naming the drifted ids — that is the gate. The repo store is read directly, never through the seed reconcile, or 676 packaged impls would be appended into the build's source of truth\n\n\
         {prog} build <id> | build --all [--wasm] [--force]   # compile a Tier-R node from its own composes closure and STAMP the verdict onto it, so `impl get` answers 'does this compile?' without running anything. The hash covers the MATERIALIZED source + the toolchain + the flags, because all three change the answer; an unchanged hash is reported `cached` and recompiles nothing, unless the artifact it names is gone — a cache that vanished must re-derive, never be trusted. `--wasm` adds the wasm32 target and writes the artifact to a CONTENT-ADDRESSED sidecar (~/.base-studio-code/knowledge/artifacts/<sha>.wasm), never inline: the store is 8.74 MB and every reader parses it\n\n\
         Implementation roles (#2863): primitive (a LANGUAGE built-in — Vec, Iterator — DESCRIBED via `--ref`, not re-coded, #2972) · algorithm (real `--code` composing primitives up).\n\
         Implementation techs (#2770): ANY language — `--tech` is not validated and never has been. Each impl `composes` other same-tech impls, rooted in that language's primitives, so a new tech simply starts its own kit (`--tech python` works today; the packaged kits are typescript · rust).\n\
         WHAT IS language-bound is the MINING half: `harvest`/`curate`/`relink` parse real source with tree-sitter and only carry grammars for ts/tsx/rs. Curating code you already have has no such limit — a session that could not harvest a Python project once concluded it could not curate one either, and left 12 real algorithms unstored rather than try (#53).\n\
         The library is the per-language implementation tier; `harvest`/`curate` (#2745) mine a project's real code into candidate implementations.\n",
    )
}

/// Write every planned file under `dir` and report what was written AND what was declined (#4192).
///
/// The skips are reported, not swallowed: a run that emitted 29 of 105 records and said only "29 emitted"
/// reads as success, when the interesting half is WHY the other 76 were left (a primitive, no provenance,
/// no code). Each carries its reason.
fn write_emit_plan(
    plan: &crate::emit::EmitPlan,
    dir: &str,
    emit: impl Fn(&Value) -> Result<(), String>,
) -> Result<(), String> {
    let root = std::path::Path::new(dir);
    for f in &plan.files {
        let out = root.join(&f.path);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        }
        std::fs::write(&out, &f.content).map_err(|e| format!("cannot write {}: {e}", out.display()))?;
    }
    emit(&serde_json::json!({
        "emitted": plan.files.len(),
        "dir": dir,
        "files": plan.files.iter().map(|f| f.path.clone()).collect::<Vec<_>>(),
        "skipped": plan.skipped.iter()
            .map(|s| serde_json::json!({ "id": s.id, "reason": s.reason }))
            .collect::<Vec<_>>(),
    }))
}

/// `bsc graph emit sync <dir>` — re-emit MANAGED files whose record moved; skip hand-edited ones.
///
/// The same contract (and, since #4192, the same shared classifier) as `bsc ui emit sync`: a file whose
/// body still matches its stamp is ours to upgrade; one that does not was edited by a human and is
/// reported rather than clobbered.
fn emit_sync(dir: &str, emit: impl Fn(&Value) -> Result<(), String>) -> Result<(), String> {
    use bsc_cli_util::vendored::SyncVerdict;
    let plan = crate::emit::plan_all(&crate::load());
    let root = std::path::Path::new(dir);
    let mut files: Vec<(String, String)> = Vec::new();
    collect_emitted_files(root, root, &mut files)?;
    let (mut synced, mut up_to_date, mut diverged, mut unknown) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for (rel, content) in &files {
        match crate::emit::classify_file(&plan, rel, content) {
            SyncVerdict::NotVendored => {}
            SyncVerdict::UpToDate => up_to_date.push(rel.clone()),
            SyncVerdict::Diverged => diverged.push(rel.clone()),
            SyncVerdict::Unknown => unknown.push(rel.clone()),
            SyncVerdict::Rewrite(fresh) => {
                let out = root.join(rel);
                std::fs::write(&out, &fresh).map_err(|e| format!("cannot write {}: {e}", out.display()))?;
                synced.push(rel.clone());
            }
        }
    }
    emit(&serde_json::json!({
        "dir": dir, "synced": synced, "upToDate": up_to_date, "diverged": diverged, "unknown": unknown,
    }))
}

/// Collect every file under `dir` as `(dir-relative POSIX path, content)`. Unreadable (binary) files are
/// skipped — a stamp is a UTF-8 line comment, so a file we cannot read as text was never ours.
fn collect_emitted_files(
    root: &std::path::Path,
    dir: &std::path::Path,
    out: &mut Vec<(String, String)>,
) -> Result<(), String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(()) };
    let mut paths: Vec<std::path::PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    paths.sort(); // order-stable output, so a sync report diffs cleanly run to run
    for path in paths {
        if path.is_dir() {
            collect_emitted_files(root, &path, out)?;
        } else if let Ok(content) = std::fs::read_to_string(&path) {
            let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
            out.push((rel, content));
        }
    }
    Ok(())
}

/// One record's runtime metrics for `--metrics`, or `Null` when nothing has been measured.
///
/// `Null` rather than a zeroed object, and the distinction matters: zeros would read as "this ran
/// nowhere and cost nothing", which is a claim. `Null` says the store has nothing to say — the same
/// honesty `bsc runtime summary` leads with.
fn runtime_metrics(record_id: &str) -> Value {
    let Some(path) = bsc_runtime::default_db_path() else {
        return Value::Null;
    };
    let Ok(store) = bsc_runtime::Store::open(&path) else {
        return Value::Null;
    };
    let Ok(rows) = store.list(&bsc_runtime::Filter::default()) else {
        return Value::Null;
    };
    let m = bsc_runtime::doctor::metrics_for(&rows, record_id);
    if m.sessions == 0 {
        return Value::Null;
    }
    serde_json::to_value(m).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    /// The help is the thing that misled, so it is the thing under test: it must NOT present the
    /// packaged kits as the accepted set, and must still say which half is grammar-bound.
    ///
    /// The BEHAVIOUR (any `--tech` is accepted) is deliberately NOT tested here. It would need a
    /// second `BSC_GRAPH_STORE` mutator, and that env var is process-global while Rust tests run in
    /// parallel — adding one made `the_packaged_seed_carries_domain_collections` fail, an unrelated
    /// test reading the packaged seed through the store this one had redirected. The existing
    /// store-backed test gets away with it only by being the sole mutator. Verified instead by
    /// running the real CLI against a throwaway store (see the change record); pinning it properly
    /// needs the store to take a path rather than an env var.
    #[test]
    fn the_help_does_not_claim_tech_is_limited_to_the_packaged_kits() {
        let h = help("bsc graph");
        assert!(h.contains("ANY language"), "curation must be described as open: {h:.0}");
        assert!(h.contains("harvest"), "the grammar-bound half must still be named");
    }

    /// `impl set` must be able to WRITE the module state, not only a harvest. 27 of the 58 stateful
    /// modules took this path (a colliding id forced them off `--apply`) and landed with no record of
    /// what they hold — the field existed and nothing could set it.
    #[test]
    fn impl_set_writes_and_clears_module_state() {
        let dir = crate::unique_temp("msflag");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = dir.join("algorithms.json");
        // SAFETY: single-threaded test setup, before any other thread reads the env.
        unsafe { std::env::set_var("BSC_GRAPH_STORE", &store) };

        let set = |extra: Vec<&str>| {
            let mut a: Vec<String> = ["impl", "set", "--tech", "typescript", "--id", "s.ts", "--role",
                                      "algorithm", "--name", "S", "--code", "export const s = 1;",
                                      "--src", "src/x/s.ts"]
                .iter().map(|s| s.to_string()).collect();
            a.extend(extra.into_iter().map(str::to_string));
            run(a, "bsc graph").unwrap();
        };
        let state_of = || {
            crate::implementations()
                .into_iter()
                .find(|i| i.get("id").and_then(Value::as_str) == Some("s.ts"))
                .and_then(|i| i.get("moduleState").cloned())
        };

        set(vec!["--module-state", "seq, pending"]);
        assert_eq!(state_of(), Some(serde_json::json!(["seq", "pending"])), "writes the bindings");

        // A MERGE leaves it alone when unsupplied (#4154) — otherwise every later edit would wipe it.
        set(vec!["--summary", "unchanged"]);
        assert_eq!(state_of(), Some(serde_json::json!(["seq", "pending"])), "preserved when not supplied");

        // …and CLEARING is `--clear`'s job, not an empty value's. `im` is the merge payload, so an
        // absent key means "leave it alone" — two ways to clear one field is how they drift apart.
        set(vec!["--clear", "moduleState"]);
        assert_eq!(state_of(), None, "--clear moduleState removes it");

        unsafe { std::env::remove_var("BSC_GRAPH_STORE") };
        let _ = std::fs::remove_dir_all(&dir);
    }

    use super::*;

    /// [`VERBS`] is only trustworthy as a source of truth if it tracks the dispatcher, so pin it to
    /// the `match` (#3391): every listed verb must dispatch, and an unlisted one must be rejected.
    #[test]
    fn verbs_match_the_dispatcher() {
        for verb in VERBS {
            // `impl`/`harvest`/`curate` bail on their own usage error before touching the store;
            // `dump`/`doctor`/`help` read it. Either way, NONE may be an unknown-command rejection.
            let err = run(vec![verb.to_string()], "bsc graph").err().unwrap_or_default();
            assert!(
                !err.contains("unknown graph command"),
                "`{verb}` is in VERBS but the dispatcher rejects it: {err}",
            );
        }
        let err = run(vec!["neighbors".to_string()], "bsc graph").unwrap_err();
        assert!(
            err.contains("unknown graph command"),
            "a verb outside VERBS must be rejected — `neighbors` is one of the concept-ontology \
             verbs #2961 deleted; got: {err}",
        );
    }

    /// REGRESSION: `--code-file` pointed at an EMPTY file stored an empty body over a real one.
    ///
    /// A script truncated its output with `open(…, "w")` and threw before writing; the 0-byte file read
    /// fine, so the existing unreadable-path guard never fired, and a 6,234-character module was erased
    /// and promoted into the committed store. The compiler caught the consequence two steps later.
    #[test]
    fn a_code_file_that_is_empty_is_refused_rather_than_stored() {
        let dir = std::env::temp_dir().join(format!("bsc-empty-code-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let empty = dir.join("empty.rs");
        std::fs::write(&empty, "   
	
").unwrap();

        let args = vec!["--code-file".to_string(), empty.to_string_lossy().into_owned()];
        let err = source_flag(&args, "--code").unwrap_err();
        assert!(err.contains("is empty"), "{err}");
        assert!(err.contains("--clear code"), "names the explicit way to clear: {err}");

        // A file with real content still reads through unchanged.
        let full = dir.join("full.rs");
        std::fs::write(&full, "pub fn f() {}").unwrap();
        let args = vec!["--code-file".to_string(), full.to_string_lossy().into_owned()];
        assert_eq!(source_flag(&args, "--code").unwrap().as_deref(), Some("pub fn f() {}"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// REGRESSION: a bare `promote` used to CREATE an empty store wherever the cwd was, so the test
    /// above — which invokes every verb — quietly wrote `crates/bsc-graph/graph/algorithms.json` into
    /// the source tree. A verb that has nothing to do must touch nothing.
    #[test]
    fn a_bare_promote_with_nothing_tracked_writes_no_file() {
        let dir = std::env::temp_dir()
            .join(format!("bsc-promote-noop-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let args = vec!["promote".to_string(), "--root".to_string(), dir.to_string_lossy().into_owned()];
        run(args, "bsc graph").expect("a no-op promote succeeds rather than erroring");

        assert!(
            !crate::repo_store::path_under(&dir).exists(),
            "a promote with nothing to promote must not create a store file",
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The help text is the CLI's own account of its surface, so every exported const must appear in
    /// it — a flag or subverb added to the `match` without reaching help (or this list) fails here.
    #[test]
    fn exported_surface_is_covered_by_the_help_text() {
        let help = help("bsc graph");
        for sub in IMPL_SUBVERBS {
            assert!(help.contains(&format!("impl {sub}")), "help omits `impl {sub}`");
        }
        for flag in FLAGS {
            assert!(help.contains(flag), "help omits `{flag}`");
        }
    }

    #[test]
    fn impl_get_reads_one_record_and_answers_null_for_a_miss() {
        // #4156 / designer request #47: verifying a record before a write used to mean dumping a whole
        // language kit (52.7KB for Rust), which overflows the shell and lands in a file OUTSIDE the
        // session's confined roots — unreadable. The designer skipped corrections rather than write
        // blind, so a per-id read is what makes a safe edit possible at all.
        let seeded = crate::implementations();
        let known = seeded.first().and_then(|im| im.get("id").and_then(serde_json::Value::as_str));
        if let Some(id) = known {
            assert!(run(vec!["impl".into(), "get".into(), id.into()], "bsc graph").is_ok());
        }
        // A miss is a normal answer, not an error — `null` keeps it parseable by the same reader.
        assert!(run(vec!["impl".into(), "get".into(), "definitely-not-here.rs".into()], "bsc graph").is_ok());
        // A missing id is a usage error, since there is nothing to look up.
        assert!(run(vec!["impl".into(), "get".into()], "bsc graph").is_err());
    }

    #[test]
    fn impl_get_falls_back_to_an_unambiguous_bare_name_but_refuses_to_guess_among_several() {
        // #118 (design-studio:designer-react): `bsc ui doctor`'s reimplementation findings print an
        // algorithm's BARE name (`` `models` (import `@bsc/algorithms/models`) ``, never the exact id
        // `models.ts`) — the SAME bare form `resolveLibrarySpec`/`libraryModuleResolver` (the preview's
        // import) and this crate's own `resolves_library` (graph_health.rs) already accept in place of the
        // id. `impl get <bare-name>` did not, so a designer verifying a finding this way got `null` and
        // reasonably read it as "the target doesn't exist" — a false read, since the import already builds.
        // The fallback is unambiguous-only: a name can collide (`index` alone names 20+ unrelated modules
        // in the real store), and a wrong silent pick on a read that precedes a write is worse than the
        // miss `impl get` already treats as a normal answer.
        let dir = crate::unique_temp("implget-name");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = dir.join("algorithms.json");
        // SAFETY: single-threaded test setup, before any other thread reads the env.
        unsafe { std::env::set_var("BSC_GRAPH_STORE", &store) };

        let set = |id: &str, name: &str| {
            run(
                vec![
                    "impl".to_string(), "set".into(),
                    "--tech".into(), "typescript".into(),
                    "--id".into(), id.into(),
                    "--role".into(), "algorithm".into(),
                    "--name".into(), name.into(),
                    "--code".into(), format!("export function {name}() {{}}"),
                    "--src".into(), format!("src/x/{id}"),
                ],
                "bsc graph",
            )
            .unwrap();
        };
        set("only-one.ts", "onlyOne");
        set("dup-a.ts", "dup");
        set("dup-b.ts", "dup");

        // A name with exactly one implementation resolves through it — the fix.
        assert!(run(vec!["impl".into(), "get".into(), "onlyOne".into()], "bsc graph").is_ok());
        // An exact id still resolves directly, unaffected by the fallback.
        assert!(run(vec!["impl".into(), "get".into(), "only-one.ts".into()], "bsc graph").is_ok());
        // A name shared by several implementations is refused rather than guessed — and the error names
        // every colliding id, so the caller can retry with the exact one it means.
        let err = run(vec!["impl".into(), "get".into(), "dup".into()], "bsc graph").unwrap_err();
        assert!(err.contains("dup-a.ts") && err.contains("dup-b.ts"), "{err}");

        unsafe { std::env::remove_var("BSC_GRAPH_STORE") };
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// #123 — a bare `tests harvest` walks the WHOLE store, so pairing one just-harvested record used to
    /// rewrite every other impl that happened to share the pass. `--id` scopes the write to the named
    /// ids: `b.ts` carries an equally real colocated test and must be left untouched when only `a.ts` is
    /// named.
    #[test]
    fn tests_harvest_scopes_pairing_to_named_ids_via_id_flag() {
        let dir = crate::unique_temp("testsharvest-id");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = dir.join("algorithms.json");
        // SAFETY: single-threaded test setup, before any other thread reads the env — the same
        // accepted-racy pattern `impl_set_writes_and_clears_module_state` already uses, since
        // `BSC_GRAPH_STORE` is process-global while Rust tests run in parallel.
        unsafe { std::env::set_var("BSC_GRAPH_STORE", &store) };

        let repo = dir.join("repo");
        std::fs::create_dir_all(repo.join("src/x")).unwrap();
        std::fs::write(repo.join("src/x/a.ts"), "export function a() {}\n").unwrap();
        std::fs::write(
            repo.join("src/x/a.test.ts"),
            "describe(\"a\", () => { it(\"works\", () => {}); });\n",
        )
        .unwrap();
        std::fs::write(repo.join("src/x/b.ts"), "export function b() {}\n").unwrap();
        std::fs::write(
            repo.join("src/x/b.test.ts"),
            "describe(\"b\", () => { it(\"works\", () => {}); });\n",
        )
        .unwrap();

        let set = |id: &str, src: &str| {
            run(
                vec![
                    "impl".into(), "set".into(),
                    "--tech".into(), "typescript".into(),
                    "--id".into(), id.into(),
                    "--role".into(), "algorithm".into(),
                    "--name".into(), id.into(),
                    "--code".into(), "export function x() {}".into(),
                    "--src".into(), src.into(),
                ],
                "bsc graph",
            )
            .unwrap();
        };
        set("a.ts", "src/x/a.ts");
        set("b.ts", "src/x/b.ts");

        run(
            vec![
                "tests".into(), "harvest".into(), repo.to_string_lossy().into_owned(),
                "--id".into(), "a.ts".into(),
            ],
            "bsc graph",
        )
        .unwrap();

        let has_tests = |id: &str| {
            crate::implementations()
                .into_iter()
                .find(|i| i.get("id").and_then(Value::as_str) == Some(id))
                .and_then(|i| i.get("tests").cloned())
                .is_some()
        };
        assert!(has_tests("a.ts"), "the named id is paired");
        assert!(!has_tests("b.ts"), "an unnamed id is left alone even though it also has a colocated test");

        unsafe { std::env::remove_var("BSC_GRAPH_STORE") };
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn impl_set_refuses_an_algorithm_with_no_provenance() {
        // #4136 — the librarian curated 10 algorithms through this verb with no `--src`, so none could
        // sit in the folder tree the rail organizes by. The CLI accepted them silently; now absence has
        // to be DECLARED. The error must name the fix, since the librarian reads it and retries.
        let base = |role: &str| vec![
            "impl".to_string(), "set".into(),
            "--tech".into(), "rust".into(),
            "--id".into(), "probe-4136.rs".into(),
            "--role".into(), role.into(),
            "--name".into(), "probe".into(),
            "--code".into(), "// x".into(),
        ];
        let err = run(base("algorithm"), "bsc graph").unwrap_err();
        assert!(err.contains("no provenance"), "{err}");
        assert!(err.contains("--src"), "names the flag to pass: {err}");
        assert!(err.contains("--no-src"), "names the explicit opt-out: {err}");
    }

    #[test]
    fn provenance_is_declared_by_src_folder_or_an_explicit_opt_out() {
        let bare = serde_json::json!({ "id": "x.rs" });
        let with_src = serde_json::json!({ "id": "x.rs", "src": "crates/x/src/lib.rs" });
        let with_folder = serde_json::json!({ "id": "x.rs", "folder": "crates/x/src" });

        // `None` for the stored record throughout: these cases are a CREATE, where the write's own
        // flags are the only provenance there can be. The stored-record arm is covered in
        // `set_gate_tests` (#4154) — that is the case this gate used to get wrong.

        // The refused shape — an algorithm with neither, and no opt-out.
        assert!(!provenance_declared("algorithm", &bare, None, false));
        // Each accepted shape, against the SAME record, so the rule is proven to turn on provenance
        // alone rather than on some other difference between the calls.
        assert!(provenance_declared("algorithm", &with_src, None, false));
        assert!(provenance_declared("algorithm", &with_folder, None, false));
        assert!(provenance_declared("algorithm", &bare, None, true)); // --no-src

        // A PRIMITIVE describes a built-in via `--ref` and has no source by design (#2972) — the gate
        // must never apply to it, or the whole primitive tier becomes unwritable.
        assert!(provenance_declared("primitive", &bare, None, false));
    }

    /// `--apply` is the module migration's WRITE path (harvest-module-can-persist), and its guard is
    /// what keeps it from becoming an accidental library dump: a directory harvest under `--apply`
    /// would write every function it walked into the store as a side effect of asking what is there.
    /// That is the deliberate curation decision `curate --apply` exists to make.
    #[test]
    fn apply_is_refused_without_module_mode() {
        let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests").join("fixtures").to_string_lossy().into_owned();
        let err = bsc_cli_util::with_repo_root(None, || {
            run(vec!["harvest".into(), fixtures, "--apply".into()], "bsc graph").unwrap_err()
        });
        assert!(
            err.contains("--module"),
            "a directory --apply must say it needs --module rather than writing the tree: {err}",
        );
    }

    #[test]
    fn harvest_and_curate_refuse_a_target_outside_the_sessions_confinement_root() {
        // #3475, the algorithms twin: the librarian holds `bsc graph` (so `Bash(bsc graph *)` already
        // matches harvest) and is confined to its own workspace. The two harvests stay SEPARATE
        // implementations by design — only this boundary primitive is shared.
        let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests").join("fixtures").to_string_lossy().into_owned();
        let elsewhere = std::env::temp_dir().to_string_lossy().into_owned();
        for verb in ["harvest", "curate"] {
            let err = bsc_cli_util::with_repo_root(Some(&elsewhere), || {
                run(vec![verb.into(), fixtures.clone()], "bsc graph").unwrap_err()
            });
            assert!(err.contains("outside every root this session may harvest"), "{verb}: {err}");
        }
        // Unconfined (no root) stays unchanged — a direct CLI run is unaffected.
        assert!(bsc_cli_util::with_repo_root(None, || run(
            vec!["harvest".into(), fixtures],
            "bsc graph"
        ))
        .is_ok());
    }
}

#[cfg(test)]
mod set_gate_tests {
    use super::*;
    use serde_json::json;

    // ── the provenance gate sees the STORED record (#4154, designer request #52) ──────────────────
    // 14 TypeScript + 3 fleet entries were blocked from routine domain/kind edits because the gate
    // inspected only this write's flags. Restating provenance on every edit is the exact shape that
    // caused the loss the merge now prevents, so the gate was pushing callers back toward it.

    #[test]
    fn an_edit_to_a_record_that_already_has_provenance_passes() {
        let write = json!({ "id": "rotate.ts", "domain": "changed" });
        let stored = json!({ "id": "rotate.ts", "src": "features/x/rotate.ts", "folder": "features/x" });
        assert!(provenance_declared("algorithm", &write, Some(&stored), false));
    }

    #[test]
    fn a_new_algorithm_with_no_provenance_anywhere_is_still_refused() {
        let write = json!({ "id": "new.ts", "domain": "x" });
        assert!(!provenance_declared("algorithm", &write, None, false));
    }

    /// `--clear src,folder` arrives as JSON null. A key that is PRESENT-but-null used to satisfy the
    /// gate, so the one write that genuinely removes an algorithm's provenance was the one it waved
    /// through.
    #[test]
    fn clearing_the_last_provenance_field_fails_the_gate() {
        let write = json!({ "id": "x.ts", "src": null, "folder": null });
        let stored = json!({ "id": "x.ts", "src": "a/x.ts", "folder": "a" });
        assert!(!provenance_declared("algorithm", &write, Some(&stored), false));
    }

    #[test]
    fn clearing_one_of_two_is_fine_the_other_still_carries_it() {
        let write = json!({ "id": "x.ts", "src": null });
        let stored = json!({ "id": "x.ts", "src": "a/x.ts", "folder": "a" });
        assert!(provenance_declared("algorithm", &write, Some(&stored), false));
    }

    #[test]
    fn a_primitive_is_exempt_and_no_src_is_the_explicit_none() {
        assert!(provenance_declared("primitive", &json!({ "id": "p" }), None, false)); // #2972
        assert!(provenance_declared("algorithm", &json!({ "id": "a" }), None, true));  // --no-src
    }

    // ── unknown flags are an error, not silence (#4154, designer request #52) ────────────────────

    #[test]
    fn an_unknown_flag_is_refused_rather_than_ignored() {
        // `--tests` has never existed here. Ignoring it let the designer conclude, three times, that a
        // working merge was deleting the field.
        let args: Vec<String> = ["impl", "set", "--id", "x", "--tests", "…"].iter().map(|s| s.to_string()).collect();
        let err = reject_unknown_flags(&args).unwrap_err();
        assert!(err.contains("--tests"), "names the offending flag: {err}");
    }

    #[test]
    fn a_value_that_looks_like_a_flag_is_not_read_as_one() {
        // `--summary` takes a value, so the next token is consumed even when it starts with `--`.
        let args: Vec<String> = ["impl", "set", "--summary", "--not-a-flag", "--pretty"].iter().map(|s| s.to_string()).collect();
        assert!(reject_unknown_flags(&args).is_ok());
    }

    #[test]
    fn a_bool_flag_does_not_swallow_the_token_after_it() {
        // `--pretty` consumes nothing, so a BAD flag right after it must still be caught.
        let args: Vec<String> = ["dump", "--pretty", "--bogus"].iter().map(|s| s.to_string()).collect();
        assert!(reject_unknown_flags(&args).unwrap_err().contains("--bogus"));
    }

    #[test]
    fn every_declared_flag_is_accepted() {
        // Non-vacuity: a typo in FLAGS would make the walk reject a flag the CLI really reads.
        for f in FLAGS {
            let args = if BOOL_FLAGS.contains(&f) {
                vec![f.to_string()]
            } else {
                vec![f.to_string(), "v".to_string()]
            };
            assert!(reject_unknown_flags(&args).is_ok(), "{f} should be accepted");
        }
    }
}

#[cfg(test)]
mod same_module_path_tests {
    use super::same_module_path;

    /// The false positive this function exists to end: one module, two spellings of its path.
    ///
    /// The stem-collision guard refuses a harvest whose id already names a DIFFERENT module. Comparing
    /// raw `src` strings made it fire on a record pointing at the SAME file — the store holds both
    /// `src/…`-prefixed and bare paths, because records arrived from different eras of the harvest — so
    /// re-harvesting a module over its own stale record was rejected as a collision.
    #[test]
    fn one_module_written_two_ways_compares_equal() {
        for (a, b) in [
            ("src/shared/lib/core/hashString.ts", "shared/lib/core/hashString.ts"),
            ("./app/console/lib/focusQueue.ts", "app/console/lib/focusQueue.ts"),
            (r"src\shared\lib\graph\selectionNeighborhood.ts", "shared/lib/graph/selectionNeighborhood.ts"),
            ("./src/features/algorithms/viz/examples/sort.ts", "features/algorithms/viz/examples/sort.ts"),
        ] {
            assert_eq!(same_module_path(a), same_module_path(b), "{a} and {b} name one module");
        }
    }

    /// ...and it must still tell two modules apart, or the fix has simply disabled the guard. These are
    /// the REAL stem collisions the guard was written for: one id, genuinely different files.
    #[test]
    fn genuinely_different_modules_still_differ() {
        for (a, b) in [
            ("src/shared/ui/registry.tsx", "features/algorithms/viz/examples/registry.ts"),
            ("src/store/types/plan.ts", "src/store/slices/plan.ts"),
            ("features/planner/preview/registry.ts", "features/designs/lib/previewRegistry.ts"),
        ] {
            assert_ne!(same_module_path(a), same_module_path(b), "{a} and {b} are different modules");
        }
    }

    /// Only the LEADING `src/` goes. A path with `src` further in keeps it — stripping every occurrence
    /// would collapse two real modules onto one name, re-introducing the bug in the other direction.
    #[test]
    fn only_the_leading_src_segment_is_stripped() {
        assert_eq!(same_module_path("src/features/src/thing.ts"), "features/src/thing.ts");
        assert_eq!(same_module_path("features/src/thing.ts"), "features/src/thing.ts");
        assert_ne!(same_module_path("src/a/src/b.ts"), same_module_path("src/a/b.ts"));
    }
}

/// `--code-file` / `--viz-code-file` — source read from DISK instead of argv (#76, designer request).
///
/// Driven at [`source_flag`] rather than through `run(…)` DELIBERATELY. An end-to-end assertion would
/// have to redirect `BSC_GRAPH_STORE`, which is process-global while Rust tests run in parallel; the
/// note above `mod tests` records that adding a second mutator of it already broke an unrelated test
/// that reads the packaged seed. `source_flag` IS the behaviour under test — it is the only thing
/// between the flag and the stored string — and testing it here is exact rather than incidental.
#[cfg(test)]
mod source_flag_tests {
    use super::source_flag;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_string()).collect()
    }

    /// A temp file whose NAME is unique per test AND per process, so a parallel run cannot collide.
    fn write_temp(tag: &str, body: &str) -> std::path::PathBuf {
        let p = crate::unique_temp(&format!("codefile-{tag}")).with_extension("ts");
        std::fs::write(&p, body).unwrap();
        p
    }

    /// THE WHOLE POINT. This body is the exact shape argv destroys: a backtick template literal with
    /// an interpolation the shell would command-substitute, and real newlines a double-quoted `\n`
    /// never becomes. It must arrive byte-identical.
    #[test]
    fn code_file_reads_backticks_interpolation_and_newlines_verbatim() {
        let body = "export function x() {\n  const n = 1;\n  return `a${n}b`;\n}\n";
        let p = write_temp("verbatim", body);
        let got = source_flag(&args(&["--code-file", p.to_str().unwrap()]), "--code").unwrap();
        assert_eq!(got.as_deref(), Some(body), "read back byte-identical");
        // And specifically that nothing collapsed: three real newlines, a live backtick, a live ${}.
        let got = got.unwrap();
        assert_eq!(got.matches('\n').count(), 4, "real newlines survived: {got:?}");
        assert!(got.contains("`a${n}b`"), "the template literal survived intact: {got:?}");
        let _ = std::fs::remove_file(&p);
    }

    /// The same door for the trace-program, which is the field MOST likely to carry a backtick.
    #[test]
    fn viz_code_file_uses_the_same_door() {
        let body = "({ run(a) { a.mark(`i${0}`); } })";
        let p = write_temp("viz", body);
        let got = source_flag(&args(&["--viz-code-file", p.to_str().unwrap()]), "--viz-code").unwrap();
        assert_eq!(got.as_deref(), Some(body));
        let _ = std::fs::remove_file(&p);
    }

    /// The inline form still works — this ADDS a door, it does not close the existing one.
    #[test]
    fn the_inline_flag_still_resolves_and_absence_is_none() {
        let got = source_flag(&args(&["--code", "export const s = 1;"]), "--code").unwrap();
        assert_eq!(got.as_deref(), Some("export const s = 1;"));
        assert_eq!(source_flag(&args(&["--id", "x.ts"]), "--code").unwrap(), None, "absent ⇒ None, not empty");
    }

    /// REFUSED, not resolved by precedence. Whichever one won, the caller believed the other was
    /// being stored — and a silently-wrong record is the exact failure this flag exists to prevent.
    #[test]
    fn both_forms_at_once_is_refused() {
        let p = write_temp("both", "export const s = 2;");
        let err = source_flag(&args(&["--code", "inline", "--code-file", p.to_str().unwrap()]), "--code")
            .unwrap_err();
        assert!(err.contains("--code") && err.contains("--code-file"), "names both flags: {err}");
        let _ = std::fs::remove_file(&p);
    }

    /// An unreadable path is an ERROR naming the path. Storing `""` would ERASE the record's source —
    /// the same corruption by a quieter route.
    #[test]
    fn an_unreadable_path_is_an_error_naming_it_never_an_empty_field() {
        let missing = std::env::temp_dir().join("bsc-graph-codefile-does-not-exist.ts");
        let err = source_flag(&args(&["--code-file", missing.to_str().unwrap()]), "--code").unwrap_err();
        assert!(err.contains("does-not-exist"), "names the path it could not read: {err}");
    }
}

/// The BATCH half of #77 — `harvest --apply` / `curate --apply` skip a retired id and name it.
#[cfg(test)]
mod batch_retired_tests {
    use super::set_impl_skipping_retired;

    fn impl_json(id: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id, "tech": "typescript", "role": "algorithm",
            "name": id, "code": "export const a = 1;",
        })
    }

    /// A retired module's FILE is usually still on disk — retirement is a decision about the store,
    /// not about the source — so a tree walk re-encountering it is the EXPECTED case. Aborting would
    /// let one retired module stop an otherwise good harvest of forty.
    #[test]
    fn a_batch_skips_a_retired_id_names_it_and_keeps_going() {
        let mut g = serde_json::json!({
            "implementations": [],
            "suppressed": [{ "id": "llm-energy.ts", "supersededBy": "algorithms-llm-energy.ts" }],
        });
        let mut skipped = Vec::new();

        set_impl_skipping_retired(&mut g, impl_json("llm-energy.ts"), &mut skipped).expect("not fatal");
        set_impl_skipping_retired(&mut g, impl_json("fresh.ts"), &mut skipped).expect("the rest still land");

        assert_eq!(skipped, vec!["llm-energy.ts".to_string()], "the skip is NAMED, not swallowed");
        let live: Vec<String> = crate::implementations_of(&g)
            .iter()
            .filter_map(|im| im.get("id").and_then(serde_json::Value::as_str).map(str::to_owned))
            .collect();
        assert_eq!(live, vec!["fresh.ts".to_string()], "retired stayed out, the good one went in");
    }

    /// A real error is still an error — the skip is scoped to retirement, not a blanket catch that
    /// would turn every rejected write into a silent no-op.
    #[test]
    fn a_genuinely_invalid_record_still_fails_the_batch() {
        let mut g = serde_json::json!({ "implementations": [] });
        let mut skipped = Vec::new();
        let bad = serde_json::json!({ "id": "b.ts", "tech": "typescript", "role": "not-a-role", "name": "B" });
        assert!(set_impl_skipping_retired(&mut g, bad, &mut skipped).is_err(), "a bad role still aborts");
        assert!(skipped.is_empty());
    }
}

/// #75 — an absent harvest target is resolved against the STORE before the filesystem answers.
#[cfg(test)]
mod already_harvested_tests {
    use super::module_paths_agree;

    /// The absolute-vs-relative case is the whole reason equality will not do: the reporter passed an
    /// absolute Windows path, and the record's `src` is repo-relative.
    #[test]
    fn an_absolute_target_agrees_with_a_repo_relative_src() {
        let abs = super::same_module_path("C:/Users/k/proj/src/features/designs/lib/colorHue.ts");
        let rel = super::same_module_path("src/features/designs/lib/colorHue.ts");
        assert!(module_paths_agree(&abs, &rel), "{abs} vs {rel}");
        // Backslashes too — Windows contributes them and the store holds both conventions.
        let win = super::same_module_path(r"C:\Users\k\proj\src\features\designs\lib\colorHue.ts");
        assert!(module_paths_agree(&win, &rel), "{win} vs {rel}");
    }

    /// The suffix must begin at a path BOUNDARY. A bare `ends_with` would call these the same module,
    /// which would name the WRONG record — worse than the unhelpful message being replaced.
    #[test]
    fn a_partial_segment_is_not_a_match() {
        assert!(!module_paths_agree("a/b/myColorHue.ts", "colorHue.ts"), "not a boundary");
        assert!(!module_paths_agree("features/x/y.ts", "features/x/z.ts"), "different files");
        assert!(module_paths_agree("a/b/colorHue.ts", "colorHue.ts"), "a real boundary DOES match");
        assert!(module_paths_agree("x.ts", "x.ts"), "equality still holds");
        assert!(!module_paths_agree("a/b/c.ts", ""), "an empty side never matches");
    }

    /// The wrong-root footgun. Passing `src` (rather than the repo root) resolved almost nothing and
    /// still exited 0, which read as "the algorithm tier has no tests" — a diagnosis filed twice off a
    /// number that only meant the paths had been joined wrong.
    #[test]
    fn a_root_that_would_double_the_source_prefix_is_refused() {
        let srcs = ["src/a/b.ts", "src/c/d.ts", "src/e/f.ts"];
        assert!(super::root_doubles_source_prefix("src", &srcs), "src/ under a root named src doubles");
        assert!(
            !super::root_doubles_source_prefix("base-studio-code", &srcs),
            "the REPO root is the correct call and must run"
        );
        // A MAJORITY, not a single hit — one stray path cannot veto an otherwise correct run.
        let mostly_fine = ["src/a.ts", "crates/b.rs", "crates/c.rs", "crates/d.rs"];
        assert!(!super::root_doubles_source_prefix("src", &mostly_fine), "one match is not the signature");
        // Degenerate roots have no name to compare and must never block.
        assert!(!super::root_doubles_source_prefix(".", &srcs), "a dot root is not a prefix");
        assert!(!super::root_doubles_source_prefix("", &srcs), "an empty root is not a prefix");
        assert!(!super::root_doubles_source_prefix("src", &[]), "nothing to judge, nothing to refuse");
    }

    /// One module test carried onto every impl extracted from that module. Real coverage for each, and a
    /// double-count for anything that materializes one file per record — so it has to be visible.
    #[test]
    fn a_test_file_claimed_by_several_impls_is_reported_as_shared() {
        let paired = vec![
            serde_json::json!({ "id": "bfs.ts", "test": "src/x/graphAlgos.test.ts" }),
            serde_json::json!({ "id": "dfs.ts", "test": "src/x/graphAlgos.test.ts" }),
            serde_json::json!({ "id": "dijkstra.ts", "test": "src/x/graphAlgos.test.ts" }),
            serde_json::json!({ "id": "order-by-rank.ts", "test": "src/y/orderByRank.test.ts" }),
        ];
        let (distinct, shared) = super::shared_test_pairings(&paired);
        assert_eq!(distinct, 2, "two distinct test FILES behind four pairings");
        assert_eq!(shared.len(), 1, "only the many-to-one file is shared");
        assert_eq!(shared[0]["test"], "src/x/graphAlgos.test.ts");
        assert_eq!(
            shared[0]["impls"].as_array().map(Vec::len),
            Some(3),
            "and it names every impl claiming it, so the double-count is countable"
        );
        // A clean 1:1 pairing is NOT reported — the signal would be worthless if everything appeared.
        let (distinct, shared) = super::shared_test_pairings(&paired[3..]);
        assert_eq!((distinct, shared.len()), (1, 0), "1:1 pairings stay silent");
    }

    /// The three cases the message has to tell apart — the reporter's exact path, resolved by `src`
    /// provenance, by `provides` specifier, and a genuinely unknown path that must still be a plain
    /// miss.
    #[test]
    fn a_covering_record_is_found_by_src_by_provides_and_not_invented() {
        let impls = vec![
            serde_json::json!({
                "id": "colour-hue.ts", "tech": "typescript", "role": "algorithm", "name": "hueOfColor",
                "src": "src/features/designs/lib/colorHue.ts",
            }),
            serde_json::json!({
                "id": "focus-queue.ts", "tech": "typescript", "role": "algorithm", "name": "focusQueue",
                // NO `src` — provenance-free records exist (`--no-src`, #4136), so `provides` is the
                // only signal that can resolve this one.
                "provides": "@/app/console/lib/focusQueue",
            }),
        ];
        // The reporter's actual failing target.
        let (id, how) = super::record_covering_path_in(
            &impls,
            "C:/Users/Kevin/Projects/rust/base-studio-code/src/features/designs/lib/colorHue.ts",
        )
        .expect("resolved by src provenance");
        assert_eq!(id, "colour-hue.ts", "and NOT by guessing the id from the filename");
        assert!(how.contains("src"), "says which signal matched: {how}");

        let (id, how) = super::record_covering_path_in(
            &impls,
            "C:/Users/Kevin/proj/src/app/console/lib/focusQueue.ts",
        )
        .expect("resolved by the provides specifier, extension and all");
        assert_eq!(id, "focus-queue.ts");
        assert!(how.contains("provides"), "says which signal matched: {how}");

        assert!(
            super::record_covering_path_in(&impls, "C:/Users/Kevin/proj/src/nope/missing.ts").is_none(),
            "a genuinely unknown path stays a plain miss — inventing a record here would be worse \
             than the message this replaces"
        );
    }
}


/// #78 — the dedup pass over the impl set.
#[cfg(test)]
mod dedup_tests {
    use super::{code_shingles, dedup_findings};
    use serde_json::Value;

    fn im(id: &str, name: &str, extra: Value) -> Value {
        let mut v = serde_json::json!({ "id": id, "tech": "typescript", "role": "algorithm", "name": name });
        if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
            for (k, val) in e {
                o.insert(k.clone(), val.clone());
            }
        }
        v
    }

    fn ids_of(f: &Value) -> Vec<String> {
        f["ids"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect()
    }

    /// A real body, long enough to clear the shingle floor — a fixture has to behave like the records
    /// do, since a three-token body scores 1.0 against anything.
    fn body(unit: &str) -> String {
        format!(
            "export function estimate(tokens, model) {{\n  \
               const rate = TABLE[model] ?? DEFAULT_RATE;\n  \
               const joules = tokens * rate * OVERHEAD;\n  \
               return {{ value: joules / 3600, unit: \"{unit}\" }};\n}}"
        )
    }

    /// THE PAIR THE REQUEST WAS FILED FOR. `llm-energy.ts` and `algorithms-llm-energy.ts` differ by
    /// formatting and a wrapper — their raw `code` is NOT equal, their names differ, and one has no
    /// `src` at all. A byte comparison, a name match and a src match ALL miss it; the shingled body
    /// scores 1.00 on the real records.
    #[test]
    fn a_reformatted_copy_is_caught_though_name_src_and_bytes_all_differ() {
        let squashed = body("Wh").replace('\n', " ").replace("  ", " ");
        assert_ne!(squashed, body("Wh"), "the fixture must NOT be byte-identical, or it proves nothing");
        let g = serde_json::json!({ "implementations": [
            im("llm-energy.ts", "estimateEnergyWh", serde_json::json!({ "code": body("Wh") })),
            im("algorithms-llm-energy.ts", "llmEnergy", serde_json::json!({
                "code": squashed,
                "src": "src/shared/lib/algorithms/llmEnergy.ts",
            })),
        ]});
        let found = dedup_findings(&g);
        assert_eq!(found.len(), 1, "the reported pair is caught: {found:#?}");
        assert_eq!(ids_of(&found[0]), vec!["algorithms-llm-energy.ts", "llm-energy.ts"]);
        assert!(found[0]["signals"][0].as_str().unwrap().contains("body"), "names the signal");
    }

    /// THE NOISE THE FIRST CUT PRODUCED, now pinned as a test. Implemented as the request literally
    /// asked — a shared name OR a shared src — these fixtures were 110 groups over 356 impls on the
    /// real store. Neither is a duplicate, and neither may report.
    #[test]
    fn a_shared_name_or_a_shared_src_alone_is_not_a_duplicate() {
        // Every feature has a `store`, an `index`, a `graphPlatform`. That is a convention.
        let g = serde_json::json!({ "implementations": [
            im("github-store.ts", "store", serde_json::json!({ "code": body("a"), "src": "src/features/github/store.ts" })),
            im("skills-store.ts", "store", serde_json::json!({ "code": body("b").replace("rate", "ratio"), "src": "src/features/skills/store.ts" })),
        ]});
        assert!(dedup_findings(&g).is_empty(), "a shared name alone: {:#?}", dedup_findings(&g));

        // Function-granularity harvest lifts MANY functions out of ONE file, so they share `src` by
        // construction — ten records carry `shared/lib/core/format.ts` on the real store.
        let g = serde_json::json!({ "implementations": [
            im("fmt-bytes.ts", "fmtBytes", serde_json::json!({ "code": body("B"), "src": "src/shared/lib/core/format.ts" })),
            im("fmt-clock.ts", "fmtClock", serde_json::json!({
                "code": body("s").replace("joules", "seconds").replace("rate", "unitRate"),
                "src": "shared/lib/core/format.ts",
            })),
        ]});
        assert!(dedup_findings(&g).is_empty(), "a shared src alone: {:#?}", dedup_findings(&g));
    }

    /// Name AND src TOGETHER is the corroborated signal — two records claiming the same function in
    /// the same file are one record twice. The `src/` prefix is normalized, or the pair is invisible.
    #[test]
    fn the_same_name_in_the_same_module_is_a_candidate_across_both_src_spellings() {
        let g = serde_json::json!({ "implementations": [
            im("layers.ts", "layerDag", serde_json::json!({ "src": "src/features/glance/lib/layers.ts" })),
            im("layer-dag.ts", "layerDag", serde_json::json!({ "src": "features/glance/lib/layers.ts" })),
        ]});
        let found = dedup_findings(&g);
        assert_eq!(found.len(), 1, "caught across both spellings: {found:#?}");
        assert!(found[0]["signals"][0].as_str().unwrap().contains("same module"));
    }

    /// THE #74 LESSON, which this request explicitly invokes. Four mutually-duplicate impls are ONE
    /// row naming all four — as pairs they would be six rows restating one fact.
    #[test]
    fn n_duplicates_report_as_one_group_naming_every_member() {
        let c = serde_json::json!({ "code": body("Wh") });
        let g = serde_json::json!({ "implementations": [
            im("a.ts", "a", c.clone()), im("b.ts", "b", c.clone()),
            im("c.ts", "c", c.clone()), im("d.ts", "d", c.clone()),
        ]});
        let found = dedup_findings(&g);
        assert_eq!(found.len(), 1, "ONE group, not 6 pairs: {found:#?}");
        assert_eq!(ids_of(&found[0]).len(), 4, "naming every member");
        let s = found[0]["suggestion"].as_str().unwrap();
        assert!(s.contains("bsc graph merge") && s.contains("PROPOSE-ONLY"), "propose-only: {s}");
    }

    /// TWO INDEPENDENT clusters stay TWO groups. This caught a real bug: every body cluster was
    /// keyed on the same constant, so all of them merged into one bucket and the real store reported
    /// `llm-energy` + `stream-merge` as a single group of four — two pairs that are 0.002 similar to
    /// each other. A confident wrong grouping is worse than the noise it replaces, which is the whole
    /// reason the density guard exists; the constant key was routing around it.
    #[test]
    fn two_unrelated_duplicate_clusters_report_separately() {
        let two = "export function tally(items) {\n  \
                     const seen = new Map();\n  \
                     for (const it of items) seen.set(it.key, (seen.get(it.key) ?? 0) + it.n);\n  \
                     return [...seen.entries()].sort((a, b) => b[1] - a[1]);\n}";
        let g = serde_json::json!({ "implementations": [
            im("llm-energy.ts", "energy", serde_json::json!({ "code": body("Wh") })),
            im("algorithms-llm-energy.ts", "llmEnergy", serde_json::json!({ "code": body("Wh") })),
            im("stream-merge.ts", "merge", serde_json::json!({ "code": two })),
            im("algorithms-stream-merge.ts", "streamMerge", serde_json::json!({ "code": two })),
        ]});
        let found = dedup_findings(&g);
        assert_eq!(found.len(), 2, "TWO groups of two, not one of four: {found:#?}");
        assert!(found.iter().all(|f| ids_of(f).len() == 2), "each names its own pair: {found:#?}");
    }

    /// Two signals over the SAME members is still one fact, so it is one row carrying both.
    #[test]
    fn signals_over_the_same_members_merge_into_one_row() {
        let g = serde_json::json!({ "implementations": [
            im("x.ts", "shared", serde_json::json!({ "code": body("Wh"), "src": "src/a/b.ts" })),
            im("y.ts", "shared", serde_json::json!({ "code": body("Wh"), "src": "a/b.ts" })),
        ]});
        let found = dedup_findings(&g);
        assert_eq!(found.len(), 1, "one row, not one per signal: {found:#?}");
        assert_eq!(found[0]["signals"].as_array().unwrap().len(), 2, "carrying BOTH signals");
    }

    /// A retired id is already folded away (#77) — proposing a merge for it sends the reader to redo
    /// one that already happened. Measured: the ONLY near-duplicates left on the real store are the
    /// two resurrection artifacts, and both are suppressed.
    #[test]
    fn a_retired_id_is_never_a_duplicate_candidate() {
        let g = serde_json::json!({
            "implementations": [
                im("gone.ts", "dupe", serde_json::json!({ "code": body("Wh") })),
                im("kept.ts", "dupe", serde_json::json!({ "code": body("Wh") })),
            ],
            "suppressed": [{ "id": "gone.ts", "supersededBy": "kept.ts" }],
        });
        assert!(dedup_findings(&g).is_empty(), "{:#?}", dedup_findings(&g));
    }

    /// A trivial body must not score. Below the floor any two one-liners are 1.0 against each other,
    /// which floods the report with the language rather than with duplication.
    #[test]
    fn a_body_below_the_shingle_floor_carries_no_signal() {
        assert!(code_shingles("export const x = 1;").len() < super::MIN_SHINGLES, "too short to score");
        let g = serde_json::json!({ "implementations": [
            im("p.ts", "p", serde_json::json!({ "code": "export const x = 1;" })),
            im("q.ts", "q", serde_json::json!({ "code": "export const x = 1;" })),
        ]});
        assert!(dedup_findings(&g).is_empty(), "identical one-liners are not a finding");
    }

    /// Unicode in a body must not panic the tokenizer — it steps by CHAR width, not by byte.
    #[test]
    fn a_multibyte_body_tokenizes_without_panicking() {
        assert!(!code_shingles("const s = \"h\u{e9}llo \u{2192} w\u{f6}rld\"; // ok ok ok ok").is_empty());
    }
}

/// The RUNTIME lens for `bsc graph doctor --runtime` (#doctor-reads-the-runtime).
///
/// The ANALYSIS is `bsc_runtime::doctor::analyze`, shared with `bsc ui doctor`, so both ask one question
/// of one dataset. What differs is the RECORD SET: implementations, keyed by id, hashed from `code`.
///
/// LINKAGE, not execution. An implementation runs inside the module that imported it, so the runtime can
/// honestly say "this was linked into a closure that served" and cannot say how many times it was called.
/// The report reflects exactly that, because a number the store cannot support would be worse than none.
///
/// `Null` on a missing/unreadable runtime.db rather than an error: a fresh checkout has not run the app,
/// and failing the health report over it would make the flag unusable the first time anyone reaches for
/// it.
fn runtime_report(g: &Value) -> Value {
    let Some(path) = bsc_runtime::default_db_path() else {
        return Value::Null;
    };
    let Ok(store) = bsc_runtime::Store::open(&path) else {
        return Value::Null;
    };
    let Ok(rows) = store.list(&bsc_runtime::Filter::default()) else {
        return Value::Null;
    };
    let records: Vec<bsc_runtime::doctor::RecordRef> = crate::implementations_of(g)
        .iter()
        .map(|im| bsc_runtime::doctor::RecordRef {
            id: im.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
            src_hash: im
                .get("code")
                .and_then(Value::as_str)
                .filter(|c| !c.is_empty())
                .map(bsc_runtime::src_hash)
                .unwrap_or_default(),
        })
        .collect();
    let report = bsc_runtime::doctor::analyze(&rows, &records);
    serde_json::to_value(report).unwrap_or(Value::Null)
}
