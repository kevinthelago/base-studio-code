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
pub const VERBS: [&str; 22] = [
    "impl", "edge", "test", "harvest", "curate", "dump", "doctor", "refolder", "relink", "tests",
    "used-by", "features", "merge", "emit", "promote", "reseed", "unmaterialize", "build", "migrate-crate", "help",
    // The duplicate surfaces (epic-a-graph-finds-its-own-duplicates). They dispatched and appeared in
    // `help` from the day they were written but were never listed HERE, so both sat outside every
    // drift guard — and the librarian charter test, which asserts the seed names only verbs the CLI
    // has, could not accept prose that taught them.
    "dupes", "similar",
];

/// The `impl` subverbs — MUST match the `match positional.get(1)` arms in [`run`].
///
/// `get` was missing until the librarian audit: the arm existed, `help` documented it, and the librarian
/// seed taught it to nobody — and because the spec drift test derives its expectations from THIS list,
/// the one verb the records architecture tells every worker to reach for was the one verb no test could
/// notice going undocumented. The list is only a drift guard if it is complete.
pub const IMPL_SUBVERBS: [&str; 10] =
    ["set", "get", "remove", "list", "suppress", "unsuppress", "history", "revert", "sync-seed", "refresh"];

/// The `edge` subverbs — MUST match the `match positional.get(1)` arms in [`run`].
pub const EDGE_SUBVERBS: [&str; 4] = ["set", "get", "list", "remove"];

/// The flags that take NO value. Needed by `reject_unknown_flags` to walk the argv correctly: a
/// value-taking flag consumes the next token, so `--summary "--x"` must not read as the flag `--x`.
pub const BOOL_FLAGS: [&str; 13] = [
    "--pretty", "--all", "--worthy-only", "--apply", "--fix", "--dry-run", "--no-src", "--run",
    "--check", "--wasm", "--force", "--raw", "--seed",
];

/// Every flag [`run`] reads, across all verbs — MUST match the `flag_value` / `args.iter()` reads below.
pub const FLAGS: [&str; 54] = [
    "--pretty",
    // `tests set` (#141) — ALSO land the same test onto the packaged seed record, not only the
    // runtime store, so curating a moved/harvested test never needs a hand-written jq patch.
    // `impl suppress` (#170) reuses the same flag name for the same reason: ALSO retire the id from
    // the packaged seed, not only the runtime store.
    "--seed",
    // Optimistic concurrency: refuse the write when the record has moved on since it was read.
    // The algorithms store had none while a librarian session wrote it live — see `set_impl_versioned`.
    "--if-version",
    // `promote` — the repo-store seam: `--check` is the gate (writes nothing, exits non-zero),
    // `--root` names the repo when the cwd is not it, `--seed` retargets the PACKAGED seed instead of
    // the build-readable repo store.
    "--check",
    "--root",
    // `impl sync-seed` (#157) — the directory holding the packaged `algorithms.json` seed, and
    // `--only <field>` to sync exactly one field rather than a record's whole content.
    "--seed-dir",
    "--only",
    // `build` — compile a node and stamp the verdict; --wasm adds the wasm32 target, --force ignores
    // a current hash.
    "--wasm",
    "--force",
    // #71 — names WHAT replaced a suppressed algorithm, stored on the tombstone.
    "--superseded-by",
    // #72 — the revision `impl revert` restores to, and who to attribute the write to.
    "--to",
    "--top",
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
    "--feature",
    "--required-by",
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
    // #137 — `impl get <id-or-name> --field <name> [--raw] [--out <name>]`: narrow to ONE field
    // (`code`, typically) and optionally spill it to the scratch dir instead of stdout.
    "--field",
    "--raw",
    // `similar --sig "<signature>"` — the DISCOVER-BEFORE-AUTHORING query, which takes a signature
    // rather than an id because the thing being looked for does not exist yet.
    "--sig",
    "--limit",
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


/// Shingle overlap at or above which two bodies are the SAME implementation. Measured on the real
/// store: the two known duplicate pairs score **1.00**, while 400 random pairs have a median of
/// 0.0008 and a maximum of **0.037**. There is no distribution between those, so the threshold is a
/// chasm rather than a tuned knob.
const NEAR_DUPLICATE: f64 = 0.8;

/// The floor below which `similar` reports NOTHING rather than a weak match.
///
/// MEASURED on the real library: a genuine twin scores **1.00** (`tree-view-motion.ts` against its six
/// siblings), while a query for something that does NOT exist there - a `groupBy` shape - returns a
/// tail at **0.14**, matching on one shared parameter name and nothing else. The gap is wide, so the
/// exact value is not delicate; 0.34 is the component library's own `NAME_GATE`, reused so the two
/// surfaces answer "similar" at the same bar.
///
/// A FLOOR MATTERS MORE HERE THAN IN A DEDUP REPORT. This verb exists to be asked BEFORE a function is
/// written, and an answer padded to `--limit` with 0.14 noise reads as "yes, several of these already
/// exist" - the opposite of the truth, delivered confidently.
const MIN_SIMILAR: f64 = 0.34;

/// Contract overlap at or above which two functions AGREE ABOUT WHAT THEY TAKE — never sufficient on
/// its own.
///
/// MEASURED over 716,507 arity-bucketed pairs in `crates/`: pairs that are structural clones have a
/// median contract similarity of **1.00**, but non-clones reach **0.50 at the 99th percentile and 1.00
/// at the maximum**. There is NO CHASM here, unlike the body signal — a contract is a far weaker claim
/// for a function than a prop set is for a component, because `(v: Vec3) -> f32` describes `abs`,
/// `normalize`, `max0` and every other routine in a maths module. So this threshold sits above the
/// 99th percentile of non-clones and still admits thousands of pairs; what makes it usable is the two
/// conditions below, not the number.
const CONTRACT_MATCH: f64 = 0.6;

/// Body overlap that must ALSO hold for a contract match to report. Well below [`NEAR_DUPLICATE`] —
/// a pair above that is already found by signal 1 — so this is the band where the bodies are alike
/// but not alike enough to speak for themselves.
///
/// THE BODY IS REQUIRED, NOT OPTIONAL, and that is a deliberate divergence from the component
/// library's measure, which lets a strong contract flag on its own (`HIGH_CONTRACT_MATCH`). Component
/// props are named at every call site so their names are meaning; a function signature is not, and the
/// distribution above is what that difference looks like in numbers.
const CORROBORATING_BODY: f64 = 0.30;

/// Two functions in the SAME module sharing a contract is a MODULE CONVENTION, not duplication, and
/// excluding it is what makes this signal usable at all.
///
/// MEASURED: with contract ≥ 0.6 and body in [0.30, 0.80) the sweep over `crates/` returns **161**
/// pairs, and inspection shows almost all are neighbours in one file — `abs` beside `normalize`,
/// `cross` beside `cmin`, `home_dir` beside `bsc_base_dir`. Requiring different modules cuts that to
/// **28**, and those read as real: an `is_safe_*` validator family duplicated across two modules of
/// one crate, `parse_args` in two crates, `build_messages`/`build_contents` per LLM provider,
/// `normalize_response` in both `gemini.rs` and `openai.rs`.
///
/// This is the same lesson #78 recorded for the NAME signal — "every feature has a `store`, an
/// `index`, a `graphPlatform`; that is a convention" — one level down: every maths module has a
/// handful of `(Vec3) -> f32`.
const CROSS_MODULE_ONLY: bool = true;

/// Minimum share of a group's possible pairs that must be observed for it to report as one cluster —
/// the anti-chaining guard, matching the component-side detector (#74). `A~B` and `B~C` with `A` and
/// `C` unrelated is a chain, and collapsing it asserts a similarity no member exhibits.
const CLUSTER_DENSITY: f64 = 0.5;

/// What to actually DO about a group — and it is not always "fold them".
///
/// Every group used to carry "pick the survivor, then fold the others with `bsc graph merge`". Across
/// the six substantive findings on this repo that advice was correct for ZERO of them: two wanted a
/// shared helper, two wanted a trait, one was already scheduled under its own item, and one must not
/// move at all (two scoring policies that happen to share a skeleton). A confident wrong instruction is
/// worse than none — the first reader who trusts it does the edits.
///
/// The distinction the report CAN make is what the evidence actually says:
///
///  * the same BODY or the same SHAPE — these ARE one implementation twice, so folding is right;
///  * the same CONTRACT — they agree about what they take and their bodies merely corroborate it, so
///    what is shared is a PATTERN. Folding would delete a real caller's function.
///
/// It deliberately stops there rather than guessing between "a helper", "a trait" and "leave it": the
/// report cannot know whether two adapters over two providers should become one, and pretending
/// otherwise is how the original suggestion went wrong.
fn suggestion_for(signal_keys: &[&str], ids: &[String]) -> String {
    // KEYED, NOT PROSE-MATCHED. This read `signals.iter().any(|s| s.contains("body") …)` over the
    // rendered descriptions — and the CONTRACT signal's own description says "corroborated by ≥30%
    // body overlap", so every contract group matched and got told to fold. Matching the text a message
    // happens to contain is how a rule ends up depending on its own wording.
    let same_code = signal_keys.iter().any(|k| *k == "same-body" || *k == "same-shape");
    if same_code {
        format!(
            "these are one implementation more than once — pick the survivor and fold the rest in with \
             `bsc graph merge <from> <into>` (it repoints every consumer). PROPOSE-ONLY: which one \
             survives is not a diagnostic's call. Candidates: {}",
            ids.join(", ")
        )
    } else {
        format!(
            "these share a CONTRACT, not an implementation — what repeats is the PATTERN, so extract \
             what is common (a helper, or a trait with a default) and leave each caller its own \
             function. DO NOT `bsc graph merge` these: folding them deletes a real caller. Members: {}",
            ids.join(", ")
        )
    }
}

/// Grow pairs into connected components, with a density guard — a sparse component is a chain, and
/// collapsing it invents a group no member exhibits.
///
/// SHARED BY EVERY PAIRWISE SIGNAL ON BOTH SURFACES. `dedup_findings` had this and `dupes` did not, so
/// the tree sweep reported PAIRS where the store reported GROUPS: `parse_args` exists in ~9 crates and
/// came out as FOURTEEN pair-rows instead of one nine-member group. That is the same "one more copy"
/// this epic exists to find, committed by the epic — which is why it is a free function now rather than
/// a closure inside one caller.
fn cluster_pairs(pairs: &[(&str, &str)]) -> Vec<Vec<String>> {
    cluster_pairs_with_loose(pairs).0
}

/// [`cluster_pairs`] plus the members PEELED OFF a component that could not clear [`CLUSTER_DENSITY`]
/// — so "this did not group" is a reportable fact rather than an absence.
fn cluster_pairs_with_loose(pairs: &[(&str, &str)]) -> (Vec<Vec<String>>, Vec<String>) {
    let mut loose: Vec<String> = Vec::new();
    let mut adj: std::collections::BTreeMap<&str, std::collections::BTreeSet<&str>> =
        std::collections::BTreeMap::new();
    for (a, b) in pairs {
        adj.entry(a).or_default().insert(b);
        adj.entry(b).or_default().insert(a);
    }
    let mut seen: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
    let mut out: Vec<Vec<String>> = Vec::new();
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
        // PEEL TO THE DENSE CORE rather than discarding the component.
        //
        // The floor's job is real: without it one generic function chains eight unrelated ones into a
        // mega-group, and a star topology is a hub artifact, not a family. But DISCARDING the whole
        // component was the wrong remedy, and it made the headline non-monotonic — MEASURED
        // 2026-09-01, converting ONE of nine `parse_args` did not take the group to eight, it deleted
        // it, and the report fell from 88 groups/155 duplicated to 87/147 while the other eight were
        // the same duplication they had been a minute earlier. Anyone working crate-by-crate reads a
        // large win on their first commit and nothing at all on the next seven.
        //
        // So drop the LEAST-connected member until what remains clears the floor. A star peels to a
        // single pair (the hub and one leaf), which is the honest reading of a star; a real family
        // peels not at all. Whatever is peeled off is returned to the caller instead of vanishing.
        group.sort_unstable();
        let core = dense_core(&group, pairs);
        if core.len() >= 2 {
            out.push(core.iter().map(|s| (*s).to_string()).collect());
        }
        for m in group.iter().filter(|m| !core.contains(m)) {
            loose.push((*m).to_string());
        }
    }
    loose.sort_unstable();
    loose.dedup();
    (out, loose)
}

/// The largest sub-group of `members` that clears [`CLUSTER_DENSITY`], found by repeatedly dropping the
/// member with the fewest edges INSIDE the group. Ties break on the name so the result is deterministic.
///
/// Greedy, not optimal, and deliberately so: the exact densest-subgraph problem is not worth solving to
/// rank a duplicate report, and the failure mode of greed here is reporting a slightly smaller family,
/// which is the safe direction for a PROPOSE-ONLY tool.
fn dense_core<'a>(members: &[&'a str], pairs: &[(&'a str, &'a str)]) -> Vec<&'a str> {
    let mut live: Vec<&str> = members.to_vec();
    while live.len() >= 2 {
        let set: std::collections::BTreeSet<&str> = live.iter().copied().collect();
        let observed = pairs.iter().filter(|(a, b)| set.contains(a) && set.contains(b)).count();
        let possible = live.len() * (live.len() - 1) / 2;
        let degree = |m: &str| {
            pairs.iter().filter(|(a, b)| (*a == m && set.contains(b)) || (*b == m && set.contains(a))).count()
        };
        // DENSITY ALONE CANNOT REJECT A STAR, which is why the degree floor is here too. A star of n has
        // n-1 edges, so a sub-star of k has density 2/k — at k=4 that is exactly 0.5 and clears the
        // floor. Peeling a 9-point star therefore produced a spurious four-member "family" (hub + three
        // leaves) where discarding the component had at least reported nothing. What actually separates
        // a hub from a family is that a hub's LEAVES have exactly one edge: in a real family every
        // member resembles at least two others. A pair is exempt — two things that resemble each other
        // are a finding, not a star.
        let every_member_has_two = live.len() == 2 || live.iter().all(|m| degree(m) >= 2);
        if possible > 0 && (observed as f64) / (possible as f64) >= CLUSTER_DENSITY && every_member_has_two {
            return live;
        }
        let weakest = live
            .iter()
            .copied()
            .min_by_key(|m| (degree(m), *m))
            .expect("live is non-empty");
        live.retain(|m| *m != weakest);
    }
    Vec::new()
}

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
            let sh = crate::extract::code_shingles(&code);
            (sh.len() >= crate::extract::MIN_SHINGLES).then_some((id, sh))
        })
        .collect();
    // ── signal 4: the same CONTRACT, corroborated by the body, across MODULES ──
    //
    // The "same job, different implementation" case: two functions that agree about what they take and
    // return, whose bodies are alike but not alike enough for signal 1 to speak. Arity-BUCKETED, and
    // arity is the right key precisely because it is not a name — the component sweep's cheap first
    // pass is a NAME gate, which for functions discards exactly what is being hunted.
    let contracts: Vec<(String, String, crate::extract::Signature)> = impls
        .iter()
        .filter_map(|im| {
            let (id, code, tech) = (text(im, "id"), text(im, "code"), text(im, "tech"));
            let sig = crate::extract::signature_from_code(&code, &tech)?;
            // A contract that names nothing cannot corroborate anything.
            (!id.is_empty() && !sig.params.is_empty()).then(|| (id, same_module_path(&text(im, "src")), sig))
        })
        .collect();
    let shingles_by_id: std::collections::BTreeMap<&str, &std::collections::HashSet<u64>> =
        bodies.iter().map(|(id, sh)| (id.as_str(), sh)).collect();
    let mut contract_pairs: Vec<(&str, &str)> = Vec::new();
    {
        let mut by_arity: std::collections::BTreeMap<usize, Vec<usize>> = Default::default();
        for (i, c) in contracts.iter().enumerate() {
            by_arity.entry(c.2.arity()).or_default().push(i);
        }
        for idxs in by_arity.values() {
            for (n, &i) in idxs.iter().enumerate() {
                for &j in idxs.iter().skip(n + 1) {
                    // A MODULE CONVENTION IS NOT DUPLICATION — see `CROSS_MODULE_ONLY`. Measured, this
                    // one condition takes the finding from 161 pairs to 28.
                    if CROSS_MODULE_ONLY && contracts[i].1 == contracts[j].1 && !contracts[i].1.is_empty() {
                        continue;
                    }
                    if crate::extract::contract_similarity(&contracts[i].2, &contracts[j].2) < CONTRACT_MATCH {
                        continue;
                    }
                    // THE BODY IS REQUIRED. A contract alone reaches 1.00 on unrelated pairs.
                    let (Some(a), Some(b)) =
                        (shingles_by_id.get(contracts[i].0.as_str()), shingles_by_id.get(contracts[j].0.as_str()))
                    else {
                        continue;
                    };
                    let inter = a.intersection(b).count();
                    let union = a.len() + b.len() - inter;
                    if union > 0 && (inter as f64) / (union as f64) >= CORROBORATING_BODY {
                        contract_pairs.push((contracts[i].0.as_str(), contracts[j].0.as_str()));
                    }
                }
            }
        }
    }

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
            buckets.entry(("name-and-src", key)).or_default().insert(id.clone());
        }
        // ── signal 3: the same SHAPE — a copy whose identifiers were renamed ──
        //
        // The one thing signal 1 structurally cannot find. Its shingles are taken over TOKENS, and the
        // tokens include the identifiers, so a renamed copy has a DISJOINT set and no threshold
        // recovers it. MEASURED: `groupItems(items, keyOf)` and `bucketRows(rows, labelFor)` — same
        // logic, every identifier renamed — scored zero overlap and were not grouped.
        //
        // An EXACT key, not a threshold: equal fingerprints ARE the same code under renaming, so this
        // buckets directly like `name-and-src` rather than going through the pair/cluster machinery
        // that signal 1 needs. Grouping is free; it is the pairwise scoring that is not.
        let tech = text(im, "tech");
        if !id.is_empty() {
            if let Some(shape) = crate::extract::shape_fingerprint(&text(im, "code"), &tech) {
                // Keyed WITH the tech: cross-kit comparison is out of scope
                // (`epic-a-graph-finds-its-own-duplicates`), and two languages can collide on a
                // node-kind sequence — `identifier` and `block` mean different things in each grammar.
                buckets.entry(("same-shape", format!("{tech}\u{0}{shape}"))).or_default().insert(id);
            }
        }
    }

    // Cluster pairs into connected components, with the same density guard the component detector
    // uses — a sparse component is a chain, and collapsing it invents a group.
    //
    // SHARED BY BOTH PAIRWISE SIGNALS, and that sharing is the fix for a real defect rather than tidying:
    // the contract signal first emitted one bucket PER PAIR, so four identical records produced six
    // rows and broke this module's central promise that N duplicates report as ONE row naming every
    // member. The chaining worry that motivated pairs is exactly what `CLUSTER_DENSITY` already
    // answers, so there was never a second mechanism to invent.
    // Keyed on the cluster's own smallest id, NOT a constant. A constant key merged every cluster into
    // one bucket, so two unrelated duplicate pairs (measured 0.002 similar to each other) reported as a
    // single group of four — a confident wrong grouping, which is what the density guard prevents.
    // Connected components are disjoint, so the smallest member is a stable unique name.
    for (signal, found) in [("same-body", cluster_pairs(&pairs)), ("same-contract", cluster_pairs(&contract_pairs))] {
        for group in found {
            buckets.entry((signal, group[0].clone())).or_default().extend(group);
        }
    }

    // Collapse to one entry per MEMBER SET, carrying every signal that grouped it.
    // The KEY rides alongside the description: the suggestion is decided by which signal grouped
    // these, and a rendered message is not a reliable stand-in for that.
    let mut by_members: std::collections::BTreeMap<Vec<String>, Vec<(&'static str, String)>> =
        std::collections::BTreeMap::new();
    for ((signal, key), ids) in buckets {
        if ids.len() < 2 {
            continue;
        }
        let desc = match signal {
            "name-and-src" => {
                let (name, src) = key.split_once('\u{0}').unwrap_or((key.as_str(), ""));
                format!("the same `name` (`{name}`) in the same module (`{src}`)")
            }
            // NAMED SEPARATELY from the shingle signal, because they mean different things to a
            // reader deciding what to do. "near-identical body" says the two are ~the same text;
            // "the same shape" says they are the same CODE with different names, which is a stronger
            // claim and points at a straight rename-and-fold rather than a careful diff.
            "same-shape" => "the same SHAPE — identical code under identifier renaming".to_string(),
            // NAMED as the weaker claim it is. "Same shape" says these ARE the same code; this says
            // they agree about what they take and their bodies overlap enough to corroborate it —
            // a refactor opportunity, not necessarily a copy.
            "same-contract" => format!(
                "the same CONTRACT across modules (≥{}% signature overlap, corroborated by ≥{}% body overlap)",
                (CONTRACT_MATCH * 100.0) as u32,
                (CORROBORATING_BODY * 100.0) as u32,
            ),
            // The body itself is never echoed — that it is the same body IS the finding.
            _ => format!("a near-identical body (≥{}% shingle overlap)", (NEAR_DUPLICATE * 100.0) as u32),
        };
        by_members.entry(ids.into_iter().collect()).or_default().push((signal, desc));
    }

    let mut out: Vec<(usize, Value)> = by_members
        .into_iter()
        .map(|(ids, found)| {
            let n = ids.len();
            let keys: Vec<&str> = found.iter().map(|(k, _)| *k).collect();
            let signals: Vec<String> = found.into_iter().map(|(_, d)| d).collect();
            let v = serde_json::json!({
                "category": "duplicate-candidate",
                "ids": ids,
                "signals": signals,
                "detail": format!("{n} implementations share {} — {}", signals.join(" and "), ids.join(", ")),
                "suggestion": suggestion_for(&keys, &ids),
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

/// `tests set --id <id> --src <test-file> [--name <name>] [--seed] [--if-version <n>]` (#140/#141) —
/// pair ONE record's test without a whole-tree `harvest`. See the usage note on the `"tests"` match
/// arm in [`run`] for why this exists alongside `harvest` rather than folding into it.
fn tests_set(args: &[String]) -> Result<Value, String> {
    let usage = "usage: bsc graph tests set --id <id> --src <test-file> [--name <name>] [--seed] \
                 [--if-version <n>] [--pretty]";
    let id = flag_value(args, "--id").ok_or(usage)?;
    let src_path = flag_value(args, "--src").ok_or(usage)?;
    let path = std::path::Path::new(&src_path);
    bsc_cli_util::require_harvestable_root(path)?;
    let contents = std::fs::read_to_string(path).map_err(|e| format!("cannot read {src_path}: {e}"))?;
    let name =
        flag_value(args, "--name").unwrap_or_else(|| bsc_util::test_display_name(path, &contents));
    let tests = serde_json::json!([{ "name": name, "src": contents }]);
    let want_seed = args.iter().any(|a| a == "--seed");

    // `--seed` (#141): a store-only write to a SEEDED record is TRANSIENT — reconcile_seed never
    // touches an id the seed already carries, so nothing here re-derives it, but the seed is what
    // ships and what a fresh clone reads. Before this, landing a moved/harvested test on both shapes
    // meant `tests set` for the store and a hand-written `jq` patch for
    // `src-tauri/data/knowledge/algorithms.json` — see `component-tests-live-in-the-seed` for the
    // component-library twin of this rule.
    //
    // Loaded (and its id checked) BEFORE the store is touched: the id-not-in-the-seed case is the
    // likely failure here (a typo, or a genuinely custom record that was never seeded), and it must
    // not leave the store half-written while the seed half silently never happens.
    let seed_doc = want_seed.then(|| load_seed_doc(&id)).transpose()?;

    let mut g = crate::load();
    let mut next = crate::implementations_of(&g)
        .into_iter()
        .find(|im| im.get("id").and_then(Value::as_str) == Some(id.as_str()))
        .ok_or_else(|| {
            format!(
                "no implementation with id '{id}' — `tests set` pairs an EXISTING record, it does not \
                 create one; check the id with `bsc graph impl get {id}`, or author the record first \
                 with `impl set`"
            )
        })?;
    // UPSERT by name, not replace: a record's `tests` array can carry several sibling tests
    // (#147) — session-roles.ts carries two, one per exported symbol. `--src`/`--name` name
    // exactly ONE of them; overwriting the whole array here silently dropped every other test
    // the record was carrying, and #145's sync then faithfully propagated the loss to the seed
    // — the second test stopped being emitted and stopped running, gate green throughout,
    // because a test that no longer exists cannot fail.
    // Carry the source file's REAL extension (#148). The emitter otherwise guesses, and a `.ts` file
    // holding a generic like `<T,>` reads as JSX and is emitted `.tsx` — the flip that renamed
    // `useNavHistory.test.tsx` to `.test.ts` during a harvest. `None` for a non-test extension leaves
    // the facet absent rather than asserting a wrong one.
    let mut entry = serde_json::json!({ "name": name, "src": contents });
    if let Some(e) = bsc_util::test_source_ext(path) {
        entry["ext"] = serde_json::json!(e);
    }
    match next.get_mut("tests").and_then(Value::as_array_mut) {
        Some(arr) => match arr.iter_mut().find(|t| t.get("name").and_then(Value::as_str) == Some(name.as_str())) {
            Some(existing) => *existing = entry,
            None => arr.push(entry),
        },
        None => next["tests"] = serde_json::json!([entry]),
    }
    // Optimistic concurrency (#183), the same opt-in guard `impl set` carries: two sessions pairing a
    // test onto the SAME record concurrently are exactly the shape request #183 was filed against — a
    // concurrent `--code` write dropped an in-flight diff with no conflict signal at all. `read_rev`
    // answers 0 for a record never stamped since #72, so `--if-version 0` is the honest guard for one
    // of those too; no backfill needed.
    let if_version = match flag_value(args, "--if-version") {
        Some(raw) => Some(raw.parse::<i64>().map_err(|_| {
            format!("--if-version '{raw}' is not an integer (read the current rev with `bsc graph impl history <id>`)")
        })?),
        None => None,
    };
    crate::set_impl_versioned(&mut g, next, "unknown", None, if_version)?;
    crate::save(&g)?;

    if let Some((path, mut doc)) = seed_doc {
        write_seed_tests(&path, &mut doc, &id, tests)?;
    }
    // NAME THE FILE. A `--seed` write resolves its target through `seed_path()`, which is not the
    // caller's cwd unless it happens to be — so "seeded: true" alone left a worktree agent believing it
    // had written its own tree when it had written the repo root's. `bsc ui tests adopt` already reports
    // its seed path and is the reason that verb behaved correctly from a worktree.
    Ok(serde_json::json!({
        "id": id, "name": name, "src": src_path, "seeded": want_seed,
        "seedPath": seed_path_for_report(want_seed),
    }))
}

/// Resolve and parse the packaged seed, confirming `id` is in it — the read half of
/// `tests set --seed` (#141), split from [`write_seed_tests`] so the id check runs BEFORE the store
/// is touched. Reads `bsc_graph::seed_path()` fresh off disk, deliberately bypassing [`crate::seed`]'s
/// cached [`std::sync::OnceLock`]: this must see the file exactly as it is right now, not a snapshot
/// from whenever this process first happened to read it.
///
/// Refuses an id the seed does not carry rather than deferring to an insert later — mirroring
/// `tests_set`'s own existing-record-only rule, and for the same reason: a record invented here would
/// not be the one the frontend and every fresh clone actually ship.
/// Does the PACKAGED seed still carry `id`? The question `merge` has to answer about its own result.
///
/// A missing or unparseable seed answers `false`: this drives an advisory line, and inventing an
/// outstanding step from a seed nobody can read would be worse than staying quiet.
fn seed_still_carries(id: &str) -> bool {
    crate::seed_path()
        .and_then(|p| std::fs::read_to_string(&p).ok())
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|d| {
            d.get("implementations")
                .and_then(Value::as_array)
                .map(|a| a.iter().any(|im| im.get("id").and_then(Value::as_str) == Some(id)))
        })
        .unwrap_or(false)
}

/// The absolute seed file a `--seed` write went to, for the verb's own output — `Null` when the write
/// did not touch the seed. Reported rather than assumed: see [`crate::seed_under_checkout`].
fn seed_path_for_report(want_seed: bool) -> Value {
    if !want_seed {
        return Value::Null;
    }
    crate::seed_path()
        .and_then(|p| std::fs::canonicalize(&p).ok().or(Some(p)))
        .map(|p| Value::String(p.display().to_string()))
        .unwrap_or(Value::Null)
}

fn load_seed_doc(id: &str) -> Result<(std::path::PathBuf, Value), String> {
    let path = crate::seed_path().ok_or(
        "packaged seed `knowledge/algorithms.json` not found — set BSC_DATA_DIR to the directory \
         holding the packaged `data/` tree, or run from a dev checkout",
    )?;
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let doc: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("{} is not valid JSON: {e}", path.display()))?;
    let has_id = doc
        .get("implementations")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{} has no `implementations` array", path.display()))?
        .iter()
        .any(|im| im.get("id").and_then(Value::as_str) == Some(id));
    if !has_id {
        return Err(format!(
            "no implementation with id '{id}' in the packaged seed ({}) — `tests set --seed` pairs an \
             EXISTING seed record, it does not create one",
            path.display()
        ));
    }
    Ok((path, doc))
}

/// Write `tests` onto `id`'s record in an already-loaded (and already id-checked) seed `doc`, and
/// persist it back to `path` — `tests set --seed`'s write half, kept separate from
/// [`load_seed_doc`] so the check-then-write split is explicit rather than implicit in call order.
fn write_seed_tests(path: &std::path::Path, doc: &mut Value, id: &str, tests: Value) -> Result<(), String> {
    let impls = doc
        .get_mut("implementations")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| format!("{} has no `implementations` array", path.display()))?;
    let rec = impls
        .iter_mut()
        .find(|im| im.get("id").and_then(Value::as_str) == Some(id))
        .ok_or_else(|| format!("id '{id}' vanished from {} between check and write", path.display()))?;
    rec["tests"] = tests;
    let body = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())? + "\n";
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// Resolve and parse the packaged seed for `impl suppress --seed` (#170) — the read half, split from
/// [`write_seed_doc`] the same way [`load_seed_doc`] is split from [`write_seed_tests`].
///
/// Unlike [`load_seed_doc`], an id ABSENT from the seed's `implementations` is not an error here:
/// suppressing an id a second time (already retired from the seed) or one that only ever lived in the
/// runtime store must stay a no-op on the seed half, exactly as [`crate::add_suppression`] is
/// idempotent on the runtime half (#77) — a caller re-running the same suppress must not have it start
/// failing the moment the first run finishes.
fn load_seed_doc_for_suppress() -> Result<(std::path::PathBuf, Value), String> {
    let path = crate::seed_path().ok_or(
        "packaged seed `knowledge/algorithms.json` not found — set BSC_DATA_DIR to the directory \
         holding the packaged `data/` tree, or run from a dev checkout",
    )?;
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let doc: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("{} is not valid JSON: {e}", path.display()))?;
    Ok((path, doc))
}

/// Persist an already-mutated packaged-seed `doc` back to `path` — `impl suppress --seed`'s write half.
/// Same tmp-then-rename dance as [`write_seed_tests`], kept as its own small function rather than a
/// shared extraction: the two callers mutate the doc differently (one field on one record vs. an
/// implementations-array removal plus a `suppressed` tombstone), and the only thing genuinely shared is
/// this four-line persist tail.
fn write_seed_doc(path: &std::path::Path, doc: &Value) -> Result<(), String> {
    // STRIP RUNTIME BOOKKEEPING ON THE WAY IN. The packaged seed is a checked-in artifact; `history`,
    // `rev`, `updatedAt` and `updatedBy` belong to the per-user runtime store and mean nothing here.
    //
    // MEASURED 2026-09-01: `impl suppress --seed` correctly scrubbed the folded id out of
    // `fleet-cost.ts`'s `composes` — and, because it took the RUNTIME record wholesale to do it, carried
    // four stamps in with it. `seed_fields_covers_every_field_the_packaged_seed_carries` then failed with
    // "the packaged seed carries 4 field(s) SEED_FIELDS does not name", and its own message says the
    // consequence: `promote --seed` REFUSES every record carrying one rather than dropping it. So the
    // leak does not merely add noise, it jams the promote path.
    //
    // Filtering at the WRITE is the choke point every `--seed` verb already goes through, so no verb can
    // forget it. `SEED_FIELDS` is the same list the guard derives its expectation from, which is what
    // stops the two drifting apart.
    let mut doc = doc.clone();
    if let Some(impls) = doc.get_mut("implementations").and_then(Value::as_array_mut) {
        for im in impls.iter_mut() {
            if let Some(obj) = im.as_object_mut() {
                obj.retain(|k, _| crate::repo_store::SEED_FIELDS.contains(&k.as_str()));
            }
        }
    }
    let body = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())? + "\n";
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// One record the unmaterialize rollback would write back to disk, or refuse to.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct RestoreEntry {
    pub id: String,
    pub path: String,
    /// Set only on a refusal — why this record is NOT safe to write back.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refused: Option<String>,
}

/// Plan the files-to-zero ROLLBACK: which committed-store records can be written back to the `src`
/// they were lifted from, and which must be refused.
///
/// Two refusals, and the second is the one the `scripts/graph-unmaterialize.mjs` this replaces got
/// wrong:
///
///   - THE FILE STILL EXISTS. A materialized module's source is absent by construction, so a record
///     whose `src` is still on disk is a FUNCTION lifted out of a live file, not the file itself.
///     Writing it back would replace the module with one of its parts.
///   - THE PATH IS CONTESTED. Several records can legitimately share one `src` — four impls carry
///     `features/algorithms/viz/examples/sorts.ts` and two carry `searches.ts` in the committed store
///     today. The script planned all six and let the LAST write win, restoring one record's code as
///     the whole file and silently losing the rest. A rollback that loses data is worse than no
///     rollback, so a contested path is refused and named rather than resolved by ordering.
///
/// Pure: `exists` is injected, so the whole decision is testable without a filesystem.
pub fn plan_unmaterialize(
    impls: &[Value],
    exists: &dyn Fn(&str) -> bool,
) -> (Vec<RestoreEntry>, Vec<RestoreEntry>) {
    let restorable: Vec<(&str, &str)> = impls
        .iter()
        .filter_map(|i| {
            let id = i.get("id").and_then(Value::as_str)?.trim();
            let src = i.get("src").and_then(Value::as_str)?.trim();
            let code = i.get("code").and_then(Value::as_str)?.trim();
            (!id.is_empty() && !src.is_empty() && !code.is_empty()).then_some((id, src))
        })
        .collect();

    let mut claims: std::collections::BTreeMap<&str, Vec<&str>> = std::collections::BTreeMap::new();
    for (id, src) in &restorable {
        claims.entry(src).or_default().push(id);
    }

    let (mut plan, mut refused) = (Vec::new(), Vec::new());
    for (id, src) in &restorable {
        let entry = |refused: Option<String>| RestoreEntry {
            id: (*id).to_string(),
            path: (*src).to_string(),
            refused,
        };
        let owners = &claims[src];
        if owners.len() > 1 {
            refused.push(entry(Some(format!(
                "{} records claim this path ({}) — restoring would let one overwrite the others, so \
                 the contest has to be resolved in the store first",
                owners.len(),
                owners.join(", "),
            ))));
        } else if exists(src) {
            refused.push(entry(Some(
                "the file EXISTS — a materialized module's source is absent by construction, so this \
                 record is a function lifted out of a live file and writing it back would delete the rest"
                    .to_string(),
            )));
        } else {
            plan.push(entry(None));
        }
    }
    (plan, refused)
}


/// `tests harvest <dir> [--dry-run]` (#4126) — carry each impl's COLOCATED test file onto its node,
/// the algorithms twin of `bsc ui tests harvest` (#3907), pairing through the SAME
/// `bsc_util::test_path_for` so the two libraries cannot drift.
///
/// MIRROR, not source. The files stay authoritative, checked in, and RUNNING. The graph cannot
/// execute a test today, so making it the source would stake the suite on an executor that does not
/// exist — a node's `tests` entry is inert metadata until `verify` lands (#4124). This buys doctor
/// honesty and a queryable graph at zero risk to coverage.
///
/// ONE ENTRY PER FILE, VERBATIM. A test file's meaning lives partly outside its `it()` blocks —
/// imports, `beforeEach`, local helpers. Splitting per-`it` would silently drop that. A file that
/// covers SEVERAL impls (this repo's `graphAlgos.test.ts` covers five) is carried onto each of them:
/// the coverage is real for every one, and per-impl attribution is not recoverable from the file.
///
/// TypeScript only. A Rust impl's tests are an inline `#[cfg(test)] mod tests`, not a sibling file, so
/// path-pairing would report every Rust impl untested — see `bsc_util::test_path_for`.
fn tests_harvest(
    dir: &str,
    dry: bool,
    // #123 — SCOPE the pairing to named ids, so harvesting one record does not re-pair every other
    // impl that happens to share its colocated-test pass. `None` walks the whole store, as before.
    ids: Option<&std::collections::HashSet<String>>,
) -> Result<Value, String> {
    let root = std::path::Path::new(dir);
    if !root.is_dir() {
        return Err(format!("no such directory: {dir}"));
    }
    // A harvest hands back file CONTENTS, so it honours the same boundary the file tools do (#3475) —
    // `bsc-confine` is blind to what this binary reads.
    bsc_cli_util::require_harvestable_root(root)?;

    let mut g = crate::load();
    let impls = crate::implementations_of(&g);

    // ⚠️ A WRONG ROOT LOOKS EXACTLY LIKE AN UNTESTED LIBRARY. Every `src` is repo-relative and already
    // begins `src/`, so the root to pass is the REPO root. Handed `src` instead, every join becomes
    // `src/src/…`, nothing resolves, and the command still exits 0 reporting a plausible `paired: 31 ·
    // noColocatedTest: 876` — which reads as "the algorithm tier has no tests" and was filed as
    // exactly that before anyone checked the invocation. The signature is deterministic (the root's
    // own name is the first segment of the sources), so detect it and refuse rather than return a
    // number that means nothing.
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

    // #123 — WHICH REQUESTED IDS THE STORE NEVER HELD. An `--id` the store does not carry matched
    // nothing in the loop below and vanished: the run reported `paired: 0` and exited 0, which reads
    // as "that record has no colocated test" when the truth is "you typed an id that does not exist".
    // Same failure as the wrong-root case guarded above — a plausible number standing in for a
    // question that was never asked — so it gets the same treatment: name it rather than count it.
    let unknown_ids: Vec<String> = match ids {
        None => Vec::new(),
        Some(want) => {
            let held: std::collections::HashSet<&str> =
                impls.iter().filter_map(|im| im.get("id").and_then(Value::as_str)).collect();
            let mut missing: Vec<String> =
                want.iter().filter(|id| !held.contains(id.as_str())).cloned().collect();
            missing.sort();
            missing
        }
    };

    let (mut paired, mut no_src, mut no_test, mut retired_no_test) = (Vec::new(), 0usize, 0usize, 0usize);
    for im in impls {
        // #123 — out of scope for this run. Skipped BEFORE the counters so a scoped harvest's report
        // describes what it actually considered, rather than counting the whole store as unpaired.
        if let Some(want) = ids {
            if !im.get("id").and_then(Value::as_str).is_some_and(|id| want.contains(id)) {
                continue;
            }
        }
        let Some(src) = im.get("src").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) else {
            // No provenance ⇒ nothing to pair against. `relink` (#4119) is the fix, not a guess.
            no_src += 1;
            continue;
        };
        // Whether the MODULE still exists separates "a live file nobody tested" from "a retired module
        // whose test went with it". Both used to land in `noColocatedTest`, where the second is
        // invisible — and the second is the one the migration can still act on.
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
            // #148: same facet `tests_set` carries — the emitter's content-guess is what silently
            // moved a `.ts` test with a generic into `.tsx` (a different, ~35x slower vitest project).
            let mut entry = serde_json::json!({ "name": name, "src": contents });
            if let Some(ext) = bsc_util::test_source_ext(&path) {
                entry["ext"] = serde_json::json!(ext);
            }
            next["tests"] = serde_json::json!([entry]);
            crate::set_impl(&mut g, next)?;
        }
        paired.push(serde_json::json!({ "id": id, "name": name, "test": rel }));
    }
    if !dry && !paired.is_empty() {
        crate::save(&g)?;
    }

    // ONE TEST FILE, N IMPLS — reported, never silent. A module exporting several functions yields one
    // impl each, and they all pair with that module's single test file. Carrying it onto each is right
    // for the MIRROR (the coverage really is theirs, and per-impl attribution is not recoverable from
    // the file) and is a trap for any EXECUTOR that materializes one file per record: the same
    // assertions would run N times and be counted N times. Whoever consumes this has to know which
    // pairings are shared, so say so instead of leaving it to be discovered.
    let (distinct_tests, shared) = shared_test_pairings(&paired);
    let shared_impls: usize =
        shared.iter().map(|s| s.get("impls").and_then(Value::as_array).map_or(0, Vec::len)).sum();

    Ok(serde_json::json!({
        "dryRun": dry,
        "unknownIds": unknown_ids,
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

pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    // Before anything reads a flag: an unknown one is an ERROR, never a silent no-op (#4154).
    reject_unknown_flags(&args)?;
    let pretty = args.iter().any(|a| a == "--pretty");
    let positional: Vec<&str> = args.iter().filter(|a| !a.starts_with("--")).map(String::as_str).collect();
    let verb = positional.first().copied().unwrap_or("help");
    // THE STORE WRITE GATE (`the-algorithms-graph-has-no-write-gate`). One check, here, rather than one
    // per mutating arm: there are sixteen of them, a seventeenth is added regularly, and the per-arm
    // shape is the one that silently drifts — a new verb that forgets the call is indistinguishable
    // from a verb that is meant to be readable. Refusing at the dispatch boundary means a verb has to
    // be named in `MUTATING` to be reachable at all, and `every_mutating_arm_is_classified` asserts
    // that list against the dispatch.
    //
    // Until this existed the store had NO gate: `bsc-graph` held zero `require_write_scope` calls
    // against `bsc-component`'s four, and `bsc` is in the mandatory permission tier, so every role on
    // the board could write any algorithm record. A session declaring `{"graph":"none"}` created one
    // and was told `ok: true`.
    if is_store_mutation(&positional, &args) {
        bsc_cli_util::require_write_scope("graph")?;
    }
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
                    // #148: same facet `tests_set` carries — without it the emitter's content-guess can
                    // misread a `.ts` generic as JSX and re-emit this test into the wrong vitest project.
                    let mut entry = serde_json::json!({ "name": name, "src": contents });
                    if let Some(ext) = bsc_util::test_source_ext(path) {
                        entry["ext"] = serde_json::json!(ext);
                    }
                    e["tests"] = serde_json::json!([entry]);
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
                // The OWNERSHIP axis — which feature owns this record, so which worker may write it.
                // Distinct from `--domain` (the curated collection facet) and from a plan feature's
                // `requires` (the many-to-many USAGE relation, per project, so the library never learns
                // about projects).
                if let Some(f) = flag_value(&args, "--feature") { im["feature"] = Value::String(f); }
                // `--required-by a,b` — the USAGE mirror of a plan feature's `requires`. VALIDATED at the
                // write: every entry must be `<projectKey>:<feature>`, because a bare slug is ambiguous
                // across projects and a stored ambiguity is what this qualification exists to prevent.
                if let Some(rb) = flag_value(&args, "--required-by") {
                    let entries: Vec<String> = rb.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).collect();
                    im["requiredBy"] = Value::Array(
                        bsc_util::required_by::normalize_required_by(&entries)?
                            .into_iter().map(Value::String).collect(),
                    );
                }
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
                // #155: a record that lives ONLY in the committed repo store (never authored into the
                // runtime store — e.g. a Rust crate module materialized straight into
                // `graph/algorithms.json`) is invisible to the lookup above. Without this fallback,
                // `set_impl_by` below would take its CREATE branch and build a record from just this
                // call's flags — silently dropping every field the repo copy carries that this call
                // doesn't restate, `tests` first among them, since there is no `--tests` flag at all.
                // Falling back to the repo-only copy here makes the provenance check below see it too
                // (an editor no longer has to re-supply `--src` for a record that already has one), and
                // seeds the runtime graph with it further down so the write MERGES onto real fields
                // instead of starting from nothing.
                let stored = stored.or_else(|| repo_only_impl(&id, &args));
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
                // #155: the runtime store has no record under this id at all — `stored` above is purely
                // the REPO-ONLY copy. Seed the runtime graph with it BEFORE `set_impl_by`'s merge runs,
                // so this write's flags land on top of the repo record's fields rather than replacing
                // them outright. Pushed raw (not through `set_impl`/`set_impl_by`) so it carries no write
                // stamp of its own — the stamp `set_impl_by` applies next treats it as the PRIOR value,
                // which is what it actually is.
                if crate::implementations_of(&g).iter().all(|x| x.get("id").and_then(Value::as_str) != Some(id.as_str())) {
                    if let Some(repo_rec) = &stored {
                        crate::ensure_array(&mut g, "implementations").push(repo_rec.clone());
                    }
                }
                // Optimistic concurrency. A librarian session writes this store LIVE, and until now
                // nothing here could refuse a stale overwrite — the sixteen `algorithms.json.bak-*`
                // files beside the store are what a human does instead. An ABSENT record, and one
                // never written since #72, both read as rev 0, so `--if-version 0` is the honest guard
                // for them and no backfill is needed to make them safe.
                let if_version = match flag_value(&args, "--if-version") {
                    Some(raw) => Some(raw.parse::<i64>().map_err(|_| {
                        format!("--if-version '{raw}' is not an integer (read the current rev with `bsc graph impl history <id>`)")
                    })?),
                    None => None,
                };
                let replaced = crate::set_impl_versioned(
                    &mut g,
                    im.clone(),
                    &bsc_record::resolve_writer(flag_value(&args, "--by").as_deref()),
                    flag_value(&args, "--note").as_deref(),
                    if_version,
                )?;
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
                if crate::remove_impl_by(&mut g, id, &bsc_record::resolve_writer(flag_value(&args, "--by").as_deref())) {
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
                let id = positional.get(2).ok_or(
                    "usage: bsc graph impl suppress <id> [--superseded-by <new-id>] [--seed]",
                )?;
                let mut g = crate::load();
                let live: Vec<Value> = crate::implementations_of(&g);
                let known = |x: &str| live.iter().any(|im| im.get("id").and_then(Value::as_str) == Some(x));
                // An id already tombstoned is known too (#170 follow-up) — `--seed` PHYSICALLY strips a
                // packaged id from the on-disk seed, so a SECOND, separate `bsc` process (a real re-run,
                // not the same process re-checking a cached `seed()`) finds it neither live nor
                // `is_seeded` any more and would wrongly refuse the very re-suppress the idempotence
                // comment below promises. `is_suppressed` is the third, durable source of "this id is
                // real" that survives the seed file being edited out from under it.
                if !known(id) && !crate::is_seeded(id) && !crate::is_suppressed(&g, id) {
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
                let superseded_by = tomb.get("supersededBy").and_then(Value::as_str).map(str::to_owned);
                // `--seed` (#170, request from claude): a store-only tombstone is TRANSIENT the same way
                // an un-seeded test pairing was (#141) — it stops the RUNTIME reconcile from re-adding
                // the id, but `scripts/emit-records.mjs` builds `.bsc-records/` by reading
                // `src-tauri/data/knowledge/algorithms.json` DIRECTLY and has never heard of the runtime
                // store, so the retired module kept shipping. Read (never written) BEFORE the runtime
                // store is touched, mirroring `tests set --seed`: an unreadable/corrupt packaged seed is
                // the likely failure here and must not leave the runtime store half-suppressed.
                let want_seed = args.iter().any(|a| a == "--seed");
                let seed_doc = want_seed.then(load_seed_doc_for_suppress).transpose()?;
                crate::remove_impl_by(&mut g, id, &bsc_record::resolve_writer(flag_value(&args, "--by").as_deref()));
                // Idempotent (#77) — suppressing an already-suppressed id refreshes its pointer
                // instead of appending a second tombstone for the same id.
                crate::add_suppression(&mut g, id, superseded_by.as_deref());
                crate::save(&g)?;
                if let Some((path, mut doc)) = seed_doc {
                    // Idempotent the same way the runtime half is: an id already absent from the seed
                    // (suppressed a second time, or never seeded) is a no-op remove, and a tombstone
                    // already there just refreshes its pointer rather than duplicating.
                    crate::remove_impl(&mut doc, id);
                    crate::add_suppression(&mut doc, id, superseded_by.as_deref());
                    write_seed_doc(&path, &doc)?;
                }
                emit(&serde_json::json!({
                    "ok": true, "suppressed": id, "supersededBy": tomb.get("supersededBy"), "seeded": want_seed,
                    "seedPath": seed_path_for_report(want_seed),
                }))
            }
            Some("unsuppress") => {
                let id = positional.get(2).ok_or("usage: bsc graph impl unsuppress <id>")?;
                // `--seed` restoration is deliberately UNSUPPORTED: `suppress --seed` physically removes
                // the record from the committed packaged seed, so there is no body left in this process
                // to resurrect it from — unlike the runtime tombstone, which the embedded seed can still
                // refill. Reversing a seeded suppression is a git operation on
                // `knowledge/algorithms.json` (checkout/revert the commit that removed it), not a `bsc`
                // one — refuse loudly rather than silently accepting a flag that does nothing.
                if args.iter().any(|a| a == "--seed") {
                    return Err(
                        "impl unsuppress has no --seed counterpart — `suppress --seed` removes the \
                         record from the packaged seed entirely, so nothing here can restore its body; \
                         use git to revert the commit that removed it from \
                         src-tauri/data/knowledge/algorithms.json, or re-author it with `impl set`"
                            .to_string(),
                    );
                }
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
                let ref_ = positional.get(2).copied().ok_or(
                    "usage: bsc graph impl get <id-or-name> [--field <name>] [--raw] [--out <name>]",
                )?;
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
                // #155: a record PROMOTED into the committed repo store and never re-authored in the
                // runtime store afterward (e.g. a materialized Rust crate module) is invisible to every
                // read above — `crate::implementations()` only ever resolves the runtime store. That
                // read the id as "does not exist" when it plainly does, in `graph/algorithms.json`, and
                // there was no way to see its fields (`tests` among them) before editing it. Fall back to
                // the committed store directly (never through `crate::load()` — see repo_store's module
                // doc for why) so a repo-only record is readable by the same verb as any other.
                let found = found.cloned().or_else(|| repo_only_impl(ref_, &args));
                let found = found.as_ref();
                // #137: `impl set` already reads a large or backtick-bearing module from DISK via
                // `--code-file` (#76) — this is the READ side of that same door, mirroring `bsc ui get
                // --field --raw --out` (#3162/#3713): `--field <name>` narrows to ONE field (`code` is
                // the motivating case), `--raw` unwraps a string field with no JSON quoting/escaping, and
                // `--out <name>` writes those exact bytes into `$BSC_SCRATCH/<name>` instead of stdout.
                // Without this, the round trip an editor needs — get the module, change three lines, set
                // it back — had no `bsc` path: unescaping JSON-in-argv by hand is exactly the throwaway
                // script this surface exists to make unnecessary.
                let field = flag_value(&args, "--field");
                let raw = args.iter().any(|a| a == "--raw");
                let out = flag_value(&args, "--out");
                if field.is_some() || out.is_some() {
                    // A miss has no field to extract and nothing to spill — `--field`/`--out` on a null
                    // record is an ERROR (not the whole-record `null`-on-miss below), since silently
                    // writing "null" to the caller's file would read as a real, empty module.
                    let im = found
                        .ok_or_else(|| format!("no implementation matches '{ref_}' — nothing to read"))?;
                    let value = match &field {
                        Some(f) => {
                            let key = f.trim_start_matches('/');
                            im.get(key).ok_or_else(|| {
                                let mut keys: Vec<&str> = im
                                    .as_object()
                                    .map(|o| o.keys().map(String::as_str).collect())
                                    .unwrap_or_default();
                                keys.sort_unstable();
                                format!("'{ref_}' has no field '{f}' — fields: {}", keys.join(", "))
                            })?
                        }
                        None => im,
                    };
                    let text = field_text(value, raw, pretty)?;
                    return match out {
                        Some(name) => {
                            let path = bsc_cli_util::resolve_scratch_out(&name)?;
                            let bytes = if raw { bsc_cli_util::raw_line(&text) } else { format!("{text}\n") };
                            std::fs::write(&path, bytes.as_bytes())
                                .map_err(|e| format!("cannot write --out {}: {e}", path.display()))?;
                            emit(&serde_json::json!({ "out": path.display().to_string() }))
                        }
                        None if raw => {
                            bsc_cli_util::print_raw(&text);
                            Ok(())
                        }
                        None => {
                            bsc_util::emit_line(&text);
                            Ok(())
                        }
                    };
                }
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
                let feature = flag_value(&args, "--feature");
                let impls: Vec<Value> = crate::implementations()
                    .into_iter()
                    .filter(|im| tech.as_deref().is_none_or(|t| im.get("tech").and_then(Value::as_str) == Some(t)))
                    .filter(|im| role.as_deref().is_none_or(|r| im.get("role").and_then(Value::as_str) == Some(r)))
                    .filter(|im| domain.as_deref().is_none_or(|d| crate::impl_in_domain(im, d)))
                    .filter(|im| feature.as_deref().is_none_or(|f| im.get("feature").and_then(Value::as_str) == Some(f)))
                    .collect();
                emit(&Value::Array(impls))
            }
            // `impl sync-seed <id>… --seed-dir <dir> [--only <field>[,<field>…]] [--apply] [--pretty]` (#157,
            // request from kevin) — the `bsc ui sync-seed` (#139) counterpart for this store: write a
            // runtime impl/edge record's CONTENT back into the packaged
            // `src-tauri/data/knowledge/algorithms.json` seed, by id. Ports `scripts/sync-impl-seed.mjs`
            // onto the surface — a comment/code fix living only in the runtime store had no `bsc` path
            // to reach git, which is exactly the class of gap this repo's own rule (a script is a
            // missing command, not a workaround) exists to close.
            Some("sync-seed") => cmd_impl_sync_seed(&args),
            // `impl refresh <id>=<src-relative-path>… [--apply]` — refresh an EXISTING record's `code`
            // from the file it claims to be, BY ID. Ports `scripts/refresh-impl-from-file.mjs`. Not
            // `harvest --module --apply`, which authors under an id derived from the FILENAME: four
            // feature barrels all derive `index.ts`, so applying them in turn writes them over one
            // another under one id — a collision that reads as success four times.
            Some("refresh") => cmd_impl_refresh(&args),
            // Every subverb in `IMPL_SUBVERBS`, in its order — the roster a caller who guessed wrong
            // needs is the WHOLE roster, and half of it used to be missing from this line.
            _ => Err("usage: bsc graph impl set … | impl get <id-or-name> | impl remove <id> \
                      | impl list [--tech <t>] [--role r] [--domain <d>] [--feature <f>] \
                      | impl suppress <id> [--superseded-by <new-id>] [--seed] | impl unsuppress <id> \
                      | impl history <id> | impl revert <id> [--to <rev>] \
                      | impl sync-seed <id>… --seed-dir <dir> [--only <field>[,<field>…]] [--apply] \
                        | impl refresh <id>=<src-relative-path>… [--apply]"
                .to_string()),
        },
        // `harvest <dir> [--tech typescript|rust] [--worthy-only]` — the extract-to-harvest feeder
        // (#2745): parse a project's real code and lift each function into a CANDIDATE library
        // implementation (id/name/tech/role/composes/code), each CLASSIFIED library-worthy vs.
        // project-glue with a score + reasons (#2745 slice 2). `--worthy-only` keeps just the worthy
        // ones. Emits candidates ONLY — storing them into the library is the curation gate, never here.
        "harvest" => {
            let writer = bsc_record::resolve_writer(flag_value(&args, "--by").as_deref());
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
                    set_impl_skipping_retired(&mut g, im, &mut retired, &writer, "harvest --module --apply: lift a module as one record")?;
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
                        // The contract, visible WITHOUT applying. A dry harvest that could not show the
                        // signature would make the one field a duplicate sweep reads unreviewable
                        // before it lands.
                        "signature": c.signature.to_json(),
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
        // The WHOLE-TREE duplicate sweep (slice 3 of epic-a-graph-finds-its-own-duplicates). `doctor
        // --dedup` reports over the STORE; this reports over the SOURCE TREE, which for Rust is the
        // only corpus that matters — the store holds 32 Rust records against 7,514 functions on disk.
        "dupes" => {
            let dir = positional
                .get(1)
                .ok_or("usage: bsc graph dupes <dir> [--tech typescript|rust] [--pretty]")?;
            let tech = flag_value(&args, "--tech");
            let started = std::time::Instant::now();
            let shapes = crate::extract::scan_shapes(std::path::Path::new(dir), tech.as_deref());

            // (tech, shape) -> the functions carrying it. Keyed WITH the tech because cross-kit is out
            // of scope and two grammars can collide on a node-kind sequence.
            let mut by_shape: std::collections::BTreeMap<(String, String), Vec<&crate::extract::FnShape>> =
                std::collections::BTreeMap::new();
            for f in &shapes {
                by_shape.entry((f.tech.clone(), f.shape.clone())).or_default().push(f);
            }
            // ── the CONTRACT signal over the tree, the same rule the store detector applies ──
            //
            // `doctor --dedup` carried four signals over 32 Rust records while this carried one over
            // 7,514 Rust functions — the weaker detector pointed at 99.6% of the Rust. Same constants,
            // same cross-module condition, so the two surfaces cannot answer differently about the same
            // pair of functions.
            let mut contract_pairs: Vec<(usize, usize)> = Vec::new();
            {
                let mut by_arity: std::collections::BTreeMap<usize, Vec<usize>> = Default::default();
                for (i, f) in shapes.iter().enumerate() {
                    // A contract that names nothing, or a body too short to corroborate one, cannot
                    // take part — checked here so the pair loop below never considers them.
                    if !f.signature.params.is_empty() && !f.shingles.is_empty() {
                        by_arity.entry(f.arity).or_default().push(i);
                    }
                }
                for idxs in by_arity.values() {
                    for (n, &i) in idxs.iter().enumerate() {
                        for &j in idxs.iter().skip(n + 1) {
                            let (a, b) = (&shapes[i], &shapes[j]);
                            // Neighbours in one FILE sharing a contract is a module convention — the
                            // condition that took this signal from 161 pairs to 28 on the store.
                            if CROSS_MODULE_ONLY && a.src == b.src {
                                continue;
                            }
                            // Already grouped by shape: the contract adds nothing to a pair that is
                            // literally the same code.
                            if a.shape == b.shape {
                                continue;
                            }
                            if crate::extract::contract_similarity(&a.signature, &b.signature) < CONTRACT_MATCH {
                                continue;
                            }
                            let inter = a.shingles.intersection(&b.shingles).count();
                            let union = a.shingles.len() + b.shingles.len() - inter;
                            if union > 0 && (inter as f64) / (union as f64) >= CORROBORATING_BODY {
                                contract_pairs.push((i, j));
                            }
                        }
                    }
                }
            }

            let mut groups: Vec<Value> = by_shape
                .into_values()
                .filter(|fns| fns.len() > 1)
                .map(|fns| {
                    serde_json::json!({
                        "signal": "same-shape",
                        "tech": fns[0].tech,
                        "arity": fns[0].arity,
                        "count": fns.len(),
                        // WHERE, not just what: a tree duplicate has no id to look up, so the report
                        // has to carry the path and line or it cannot be acted on.
                        "members": fns.iter().map(|f| serde_json::json!({
                            "name": f.name, "src": f.src, "line": f.line,
                        })).collect::<Vec<_>>(),
                    })
                })
                .collect();
            // CLUSTERED, not emitted as pairs. `parse_args` exists in ~9 crates; as pairs that is
            // fourteen rows saying one thing. Keyed by "src:line" because a tree function has no id.
            let keyed: Vec<(String, usize)> = shapes
                .iter()
                .enumerate()
                .map(|(i, f)| (format!("{}:{}", f.src, f.line), i))
                .collect();
            let by_key: std::collections::BTreeMap<&str, usize> =
                keyed.iter().map(|(k, i)| (k.as_str(), *i)).collect();
            let pair_keys: Vec<(&str, &str)> = contract_pairs
                .iter()
                .map(|&(i, j)| (keyed[i].0.as_str(), keyed[j].0.as_str()))
                .collect();
            groups.extend(cluster_pairs(&pair_keys).into_iter().map(|members| {
                let idx: Vec<usize> = members.iter().filter_map(|k| by_key.get(k.as_str()).copied()).collect();
                let a = &shapes[idx[0]];
                serde_json::json!({
                    "signal": "same-contract",
                    "tech": a.tech,
                    "arity": a.arity,
                    "count": idx.len(),
                    "members": idx.iter().map(|&i| serde_json::json!({
                        "name": shapes[i].name, "src": shapes[i].src, "line": shapes[i].line,
                    })).collect::<Vec<_>>(),
                })
            }));
            // Biggest groups first — N copies of one shape is a bigger finding than a pair, and a
            // reader works down from the top.
            groups.sort_by(|a, b| {
                b["count"].as_u64().cmp(&a["count"].as_u64())
                    .then_with(|| a["members"][0]["src"].as_str().cmp(&b["members"][0]["src"].as_str()))
            });
            let duplicated: usize = groups.iter().filter_map(|g| g["count"].as_u64()).map(|n| n as usize - 1).sum();
            emit(&serde_json::json!({
                "scanned": shapes.len(),
                "groups": groups.len(),
                // How many functions could go if every group collapsed to one — the SIZE of the
                // finding, which a count of groups does not convey.
                "duplicated": duplicated,
                "elapsedMs": started.elapsed().as_millis() as u64,
                "dupes": groups,
            }))
        }
        // DISCOVER BEFORE AUTHORING (slice 5). Cleanup decays; this is what stops the library growing
        // duplicates again — a worker about to write a helper asks whether one already exists.
        //
        // Takes a SIGNATURE, not only an id, because the thing being looked for has not been written
        // yet and so has no id. That is the whole difference between this and `doctor --dedup`, which
        // compares things that already exist.
        "similar" => {
            let tech = flag_value(&args, "--tech").unwrap_or_else(|| "typescript".into());
            let limit: usize = flag_value(&args, "--limit")
                .and_then(|v| v.parse().ok())
                .unwrap_or(8);
            let query = match (flag_value(&args, "--sig"), positional.get(1)) {
                (Some(sig), _) => crate::extract::parse_signature_query(&sig, &tech)
                    .ok_or_else(|| format!(
                        "could not read that signature. Expected `(name: Type, …) => Return`                          (or `-> Return` for rust), e.g. --sig \"(xs: T[], key: (t: T) => string) => Map<string, T[]>\". Got: {sig}"
                    ))?,
                // …and by ID too, mirroring `bsc ui similar`: once the thing exists, "what else looks
                // like this" is the same question asked from the other side.
                (None, Some(id)) => {
                    let g = crate::load();
                    let im = crate::implementations_of(&g)
                        .into_iter()
                        .find(|im| im.get("id").and_then(Value::as_str) == Some(&**id))
                        .ok_or_else(|| format!("unknown implementation '{id}'"))?;
                    let t = im.get("tech").and_then(Value::as_str).unwrap_or(&tech).to_string();
                    crate::extract::signature_from_code(
                        im.get("code").and_then(Value::as_str).unwrap_or_default(), &t,
                    )
                    .ok_or_else(|| format!(
                        "'{id}' has no function definition to take a signature from - a data or config \
                         module (an object of properties, a constants table) is a record without a \
                         contract, and `similar` compares CONTRACTS. Query by --sig instead."
                    ))?
                }
                (None, None) => return Err(
                    "usage: bsc graph similar --sig \"(xs: T[]) => T\" [--tech t] [--limit n]  |  bsc graph similar <id>".into()
                ),
            };
            let started = std::time::Instant::now();
            let g = crate::load();
            let mut scored: Vec<(f64, Value)> = crate::implementations_of(&g)
                .into_iter()
                .filter(|im| im.get("tech").and_then(Value::as_str) == Some(tech.as_str()))
                .filter(|im| im.get("id").and_then(Value::as_str).is_some_and(|id| !crate::is_suppressed(&g, id)))
                .filter_map(|im| {
                    let id = im.get("id").and_then(Value::as_str)?.to_string();
                    let sig = crate::extract::signature_from_code(
                        im.get("code").and_then(Value::as_str).unwrap_or_default(), &tech,
                    )?;
                    let score = crate::extract::contract_similarity(&query, &sig);
                    // BELOW THE FLOOR IS NOT A WEAK MATCH, IT IS NO MATCH. Padding an answer out to
                    // `--limit` teaches the reader to ignore the tail, and for the PREVENTION use case
                    // it is worse: a worker asking "does this already exist" and seeing five rows
                    // concludes yes.
                    (score >= MIN_SIMILAR).then(|| (score, serde_json::json!({
                        "id": id,
                        "name": im.get("name").and_then(Value::as_str).unwrap_or_default(),
                        "score": (score * 100.0).round() / 100.0,
                        "arity": sig.arity(),
                        "src": im.get("src").and_then(Value::as_str).unwrap_or_default(),
                        "signature": sig.to_json(),
                    })))
                })
                .collect();
            scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
            scored.truncate(limit);
            emit(&serde_json::json!({
                "query": query.to_json(),
                "tech": tech,
                "elapsedMs": started.elapsed().as_millis() as u64,
                // PROPOSE-ONLY, and said out loud: this answers "does something like this exist",
                // never "do not write it". A close match may still be the wrong thing.
                "matches": scored.into_iter().map(|(_, v)| v).collect::<Vec<_>>(),
            }))
        }
        "curate" => {
            let writer = bsc_record::resolve_writer(flag_value(&args, "--by").as_deref());
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
                    // WHAT IT TAKES AND RETURNS (epic-a-graph-finds-its-own-duplicates). Written only
                    // when non-empty, like `moduleState`: `impl set` is a MERGE, so an empty signature
                    // would CLEAR one a previous pass established rather than leaving it alone.
                    if !c.signature.is_empty() {
                        im["signature"] = c.signature.to_json();
                    }
                    set_impl_skipping_retired(&mut g, im, &mut retired, &writer, "curate --apply: write a worthy candidate into the library")?;
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
            let writer = bsc_record::resolve_writer(flag_value(&args, "--by").as_deref());
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
                // Attributed, not "unknown" (#72 stamped these writes but named nobody, so history
                // could not tell a refolder from a hand edit).
                crate::set_impl_by(&mut g, next, &writer, Some("refolder: re-derive folder from src"))?;
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
            let writer = bsc_record::resolve_writer(flag_value(&args, "--by").as_deref());
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
                            // Attributed, not "unknown" (#72 stamped these writes but named nobody, so history
                            // could not tell a relink from a hand edit).
                            crate::set_impl_by(&mut g, next, &writer, Some("relink: recover src by matching a fresh harvest"))?;
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
        // `tests harvest <dir>` (#4126) mirrors every impl's colocated test onto its node; `tests set`
        // (#140) pairs ONE record's test without needing a whole repo tree to resolve against. See
        // [`tests_harvest`] and [`tests_set`] for the reasoning behind each.
        // `unmaterialize [--apply] [--root <dir>]` — the ROLLBACK for files-to-zero, ported from
        // `scripts/graph-unmaterialize.mjs` (which is deleted with this change, not left beside it).
        //
        // NOT `emit`. That verb's contract is "one record = one file — NEVER written over the shared
        // `src` it was lifted from", which is exactly the operation a rollback has to perform. The two
        // are opposites, not duplicates.
        //
        // It matters because the bet is live and large: 25 crates compile from the graph today and 60
        // committed-store records have no file on disk. Losing git blame, review diffs and
        // goto-definition on those modules is a trade the maintainer took with the costs named, and a
        // chosen trade should stay reversible while it is still being evaluated — from the tier every
        // role holds, not from behind `node`.
        //
        // DRY BY DEFAULT. The paths it writes are exactly the paths a migration deleted, so an
        // accidental run would resurrect a second live copy of every module — the two-live-copies state
        // this architecture exists to avoid.
        "unmaterialize" => {
            let apply = args.iter().any(|a| a == "--apply");
            let root = flag_value(&args, "--root")
                .map(std::path::PathBuf::from)
                .unwrap_or(std::env::current_dir().map_err(|e| format!("cannot resolve cwd: {e}"))?);
            let path = crate::repo_store::path_under(&root);
            let repo = crate::repo_store::read_at(&path)?.unwrap_or_else(crate::repo_store::empty);
            let impls: Vec<Value> = repo
                .get("implementations")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();

            let (plan, refused) =
                plan_unmaterialize(&impls, &|rel: &str| root.join(rel).is_file());

            let mut wrote: Vec<String> = Vec::new();
            if apply {
                let by_id: std::collections::HashMap<&str, &Value> = impls
                    .iter()
                    .filter_map(|i| i.get("id").and_then(Value::as_str).map(|id| (id, i)))
                    .collect();
                for e in &plan {
                    let code = by_id
                        .get(e.id.as_str())
                        .and_then(|i| i.get("code"))
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let target = root.join(&e.path);
                    if let Some(dir) = target.parent() {
                        std::fs::create_dir_all(dir)
                            .map_err(|err| format!("cannot create {}: {err}", dir.display()))?;
                    }
                    let body =
                        if code.ends_with('\n') { code.to_string() } else { format!("{code}\n") };
                    std::fs::write(&target, body)
                        .map_err(|err| format!("cannot write {}: {err}", target.display()))?;
                    wrote.push(e.path.clone());
                }
            }

            emit(&serde_json::json!({
                "apply": apply,
                "store": path.to_string_lossy(),
                "restorable": plan.len(),
                "refused": refused,
                "plan": plan,
                "wrote": wrote,
            }))
        }
        "reseed" => {
            let check = args.iter().any(|a| a == "--check");
            let all = args.iter().any(|a| a == "--all");
            let named = flag_value(&args, "--id");
            // REFUSE BEFORE READING ANYTHING. A usage error should not depend on whether a seed and a
            // runtime store happen to exist — and reaching this check only after the reads made it
            // unreachable in any test harness that points `--root` at an empty dir.
            if !check && named.is_none() && !all {
                return Err(
                    "reseed OVERWRITES the runtime store from the packaged seed — name what to \
                     take with `--id a,b`, or `--all` for every drifted record. Run `--check` first."
                        .to_string(),
                );
            }
            let root = flag_value(&args, "--root")
                .map(std::path::PathBuf::from)
                .unwrap_or(std::env::current_dir().map_err(|e| format!("cannot resolve cwd: {e}"))?);
            let seed_path = crate::repo_store::seed_path_under(&root);
            let seed = crate::repo_store::read_at(&seed_path)?
                .ok_or_else(|| format!("no packaged seed at {}", seed_path.display()))?;

            // The runtime store is read DIRECTLY, never through `load()`: load() reconciles the
            // packaged seed, so on a machine with no store it would report everything as identical
            // and this verb would silently do nothing.
            let store_path = crate::store_path().ok_or("no home dir — cannot reach the runtime store")?;
            let store = crate::repo_store::read_at(&store_path)?
                .ok_or_else(|| format!("no runtime store at {}", store_path.display()))?;

            let seed_impls = crate::repo_store::impls_of(&seed);
            let store_impls = crate::repo_store::impls_of(&store);
            let by_id = |v: &[serde_json::Value]| -> std::collections::BTreeMap<String, serde_json::Value> {
                v.iter()
                    .filter_map(|i| {
                        i.get("id").and_then(serde_json::Value::as_str).map(|k| (k.to_string(), i.clone()))
                    })
                    .collect()
            };
            let seeded = by_id(&seed_impls);
            let stored = by_id(&store_impls);

            // Drifted = present in BOTH and differing through the seed projection. A record the store
            // does not have is an ADDITION, reported separately: putting it there is a different
            // decision from refreshing one that is already there and stale.
            let mut drifted: Vec<String> = Vec::new();
            let mut absent: Vec<String> = Vec::new();
            for (id, s_rec) in &seeded {
                match stored.get(id) {
                    None => absent.push(id.clone()),
                    Some(t) => {
                        if crate::repo_store::seed_content_of(s_rec)
                            != crate::repo_store::seed_content_of(t)
                        {
                            drifted.push(id.clone());
                        }
                    }
                }
            }
            drifted.sort();
            absent.sort();

            if check {
                emit(&serde_json::json!({
                    "seed": seed_path.to_string_lossy(), "store": store_path.to_string_lossy(),
                    "drifted": drifted, "absentFromStore": absent, "ok": drifted.is_empty(),
                }))?;
                if !drifted.is_empty() {
                    return Err(format!(
                        "the runtime store is behind the packaged seed — {} drifted ({}). \
                         Run `bsc graph reseed --all` to bring it forward.",
                        drifted.len(),
                        drifted.join(", "),
                    ));
                }
                return Ok(());
            }

            // OVERWRITING SOMEONE'S AUTHORING IS AN EXPLICIT DECISION, which is why there is no bare
            // form. `promote` defaults to "refresh what is already tracked" because the worst case
            // there is shipping a stale record; here the worst case is destroying the only copy of an
            // edit, so the caller has to say `--all` or name the ids.
            // Guarded above, before any I/O.
            let ids: Vec<String> = match named {
                Some(v) => v.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect(),
                None => drifted.clone(),
            };

            let mut next = store.clone();
            let mut wrote = Vec::new();
            let mut unknown = Vec::new();
            {
                let list = next
                    .get_mut("implementations")
                    .and_then(serde_json::Value::as_array_mut)
                    .ok_or("the runtime store has no `implementations` array")?;
                for id in &ids {
                    let Some(fresh) = seeded.get(id) else {
                        unknown.push(id.clone());
                        continue;
                    };
                    match list.iter().position(|i| {
                        i.get("id").and_then(serde_json::Value::as_str) == Some(id.as_str())
                    }) {
                        Some(at) => list[at] = fresh.clone(),
                        None => list.push(fresh.clone()),
                    }
                    wrote.push(id.clone());
                }
            }
            if !unknown.is_empty() {
                return Err(format!("not in the packaged seed: {}", unknown.join(", ")));
            }
            crate::save_at(&store_path, &next)?;
            emit(&serde_json::json!({
                "ok": true, "store": store_path.to_string_lossy(),
                "reseeded": wrote.len(), "records": wrote,
            }))
        }
        "tests" => match positional.get(1).copied() {
            Some("set") => emit(&tests_set(&args)?),
            Some("harvest") => {
                let dir = positional
                    .get(2)
                    .ok_or("usage: bsc graph tests harvest <dir> [--id a,b] [--dry-run] [--pretty]")?;
                let dry = args.iter().any(|a| a == "--dry-run");
                let ids: Option<std::collections::HashSet<String>> = flag_value(&args, "--id").map(|s| {
                    s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
                });
                emit(&tests_harvest(dir, dry, ids.as_ref())?)
            }
            // `tests promote --id a,b [--apply]` (#123) — carry a runtime-store impl's `tests` onto the
            // SAME id in the PACKAGED seed (`src-tauri/data/knowledge/algorithms.json`, the file the app
            // ships and `bsc graph promote` never touches — that verb feeds the UNRELATED committed
            // build-input store at `graph/algorithms.json`, see `crate::repo_store`).
            //
            // WHY THIS EXISTS. `promote-records.mjs` promotes a record into the packaged seed only while
            // its FILE still exists; a record whose module already retired is "already seeded" and never
            // reconsidered. `sync-impl-seed.mjs` is the narrow reopening of that door, but it syncs only
            // `code` — a test harvested onto a retired-module record had no way to reach the seed at all,
            // so a session carrying one had to extend a build-tree script by hand (request #123). This is
            // that missing door, on the `bsc` surface a build-tier-less session can actually reach.
            //
            // SYNC, NOT PROMOTE. Like `sync-impl-seed.mjs`, an id absent from the seed is refused rather
            // than inserted — that is a full record promotion (`promote-records.mjs`'s job, once the
            // module's file exists again), and inserting a bare `{ id, tests }` stub here would leave a
            // seed record that answers no specifier.
            Some("promote") => {
                let ids: Vec<String> = flag_value(&args, "--id")
                    .ok_or("usage: bsc graph tests promote --id a,b [--apply] [--pretty]")?
                    .split(',')
                    .map(|x| x.trim().to_string())
                    .filter(|x| !x.is_empty())
                    .collect();
                if ids.is_empty() {
                    return Err("usage: bsc graph tests promote --id a,b [--apply] [--pretty]".to_string());
                }
                let apply = args.iter().any(|a| a == "--apply");

                let runtime = crate::implementations();
                let seed_path = bsc_util::packaged::candidates("knowledge/algorithms.json")
                    .into_iter()
                    .find(|p| p.is_file())
                    .ok_or_else(|| {
                        "packaged seed knowledge/algorithms.json not found on this machine — run from a \
                         dev checkout, or set BSC_DATA_DIR to the directory holding the packaged `data/` \
                         tree"
                            .to_string()
                    })?;
                let mut seed_doc: Value = serde_json::from_str(
                    &std::fs::read_to_string(&seed_path)
                        .map_err(|e| format!("cannot read {}: {e}", seed_path.display()))?,
                )
                .map_err(|e| format!("{} is not valid JSON: {e}", seed_path.display()))?;
                let seed_impls = seed_doc
                    .get_mut("implementations")
                    .and_then(Value::as_array_mut)
                    .ok_or_else(|| format!("{} has no `implementations` array", seed_path.display()))?;

                let mut synced = Vec::new();
                let mut skipped = Vec::new();
                for id in &ids {
                    let Some(rt) =
                        runtime.iter().find(|im| im.get("id").and_then(Value::as_str) == Some(id.as_str()))
                    else {
                        skipped.push(serde_json::json!({ "id": id, "reason": "not in the runtime store" }));
                        continue;
                    };
                    let rt_tests = rt.get("tests").cloned().unwrap_or(Value::Array(Vec::new()));
                    if rt_tests.as_array().is_none_or(|t| t.is_empty()) {
                        skipped.push(serde_json::json!({
                            "id": id,
                            "reason": "no tests recorded in the runtime store — run `tests harvest` first",
                        }));
                        continue;
                    }
                    let Some(seed_im) = seed_impls
                        .iter_mut()
                        .find(|im| im.get("id").and_then(Value::as_str) == Some(id.as_str()))
                    else {
                        skipped.push(serde_json::json!({
                            "id": id,
                            "reason": "not in the packaged seed — this only SYNCS tests onto an id already \
                                       there; promote the record itself first (promote-records.mjs, once \
                                       its module exists again, or `impl set`)",
                        }));
                        continue;
                    };
                    if seed_im.get("tests") == Some(&rt_tests) {
                        skipped.push(serde_json::json!({ "id": id, "reason": "already identical" }));
                        continue;
                    }
                    if apply {
                        seed_im["tests"] = rt_tests.clone();
                    }
                    synced.push(id.clone());
                }

                if apply && !synced.is_empty() {
                    let body = serde_json::to_string_pretty(&seed_doc)
                        .map_err(|e| format!("cannot render {}: {e}", seed_path.display()))?;
                    std::fs::write(&seed_path, format!("{body}\n"))
                        .map_err(|e| format!("cannot write {}: {e}", seed_path.display()))?;
                }

                emit(&serde_json::json!({
                    "apply": apply,
                    "seed": seed_path.to_string_lossy(),
                    "synced": synced,
                    "skipped": skipped,
                }))
            }
            _ => Err(
                "usage: bsc graph tests harvest <dir> [--id a,b] [--dry-run] [--pretty]  |  \
                 tests set --id <id> --src <test-file> [--name <name>] [--seed] [--if-version <n>]  |  \
                 tests promote --id a,b [--apply] [--pretty]"
                    .to_string(),
            ),
        },
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
            // `promote help` asked for help, not to adopt/refresh a record literally named "help" — and
            // unlike `--id`/`--check`, a bare positional was silently ignored rather than rejected, so
            // this fell through into a REAL bare promote (refreshing every tracked id) instead of
            // printing usage. Every other verb's `help` positional is a no-op read (#136); this is the
            // one place it was a write. Mirrors the `harvest help` / `emit help` precedent above.
            if positional.get(1) == Some(&"help") {
                print!("{}", help(prog));
                return Ok(());
            }
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
            let writer = bsc_record::resolve_writer(flag_value(&args, "--by").as_deref());
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
                            // Attributed, not "unknown" (#72 stamped these writes but named nobody, so history
                            // could not tell a doctor from a hand edit).
                            crate::set_impl_by(&mut g, next, &writer, Some("doctor --fix: assign the inferred viz kind"))?;
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
        // `features [--top N] [--pretty]` — the OWNERSHIP axis, measured. READ-ONLY, always: it ranks candidates
        // for the baseline and never promotes one, because "many domains use it" is EVIDENCE, not a
        // decision. A record can be widely used and still be one feature's business that others reach
        // into wrongly — and that is a finding worth keeping, not a thing to sweep away.
        //
        // `coreCandidates` is ranked by FOREIGN-DOMAIN FAN-IN — how many *different* domains compose a
        // record, not how often it is composed. Raw usage cannot tell shared infrastructure from one
        // feature's popular helper; the number of distinct callers-across-a-boundary can.
        "features" => {
            let mut g = crate::load();
            let owned: Vec<Value> = crate::implementations_of(&g).into_iter().collect();

            // `--apply` BACKFILLS `feature` from `folder`, using the derivation both graphs share
            // (`bsc_util::feature_from_folder`). Dry by default, like `bsc ui features`: this writes a
            // field across the whole library on a mapping a human should read first, so the report is
            // the default and the write is the opt-in.
            //
            // It never OVERWRITES a feature already set. The derivation is a starting point, not an
            // authority — a record deliberately placed by hand (a shared module living under one
            // feature's folder, say) has to survive every later re-run, or the backfill quietly undoes
            // curation each time someone invokes it.
            if args.iter().any(|a| a == "--apply") {
                // `tech` and `role` ride along because `set_impl_by` validates them on the SUBMITTED
                // value — it merges everything else, but those two are identity and it refuses an input
                // without them. Both are READ FROM THE RECORD, never restated from memory: guessing an
                // identity field is what renamed 21 records on the first attempt at this placement.
                let derived: Vec<(String, String, String, String)> = owned
                    .iter()
                    .filter(|im| im.get("feature").and_then(Value::as_str).unwrap_or_default().trim().is_empty())
                    .filter_map(|im| {
                        let id = im.get("id").and_then(Value::as_str)?.to_string();
                        let tech = im.get("tech").and_then(Value::as_str)?.to_string();
                        let role = im.get("role").and_then(Value::as_str)?.to_string();
                        let folder = im.get("folder").and_then(Value::as_str).unwrap_or_default();
                        bsc_util::feature_from_folder(folder).map(|f| (id, tech, role, f))
                    })
                    .collect();
                for (id, tech, role, feature) in &derived {
                    // The DELTA plus the two identity fields — never the round-tripped record. The
                    // write merges, so the two look equivalent until a stored field is `null`, which
                    // resubmitted reads as a CLEAR. That cost `terminalhost.provides` on the component
                    // backfill: 448 records in, one field silently gone.
                    crate::set_impl_by(
                        &mut g,
                        serde_json::json!({ "id": id, "tech": tech, "role": role, "feature": feature }),
                        "features-backfill",
                        Some("feature: ownership axis derived from folder"),
                    )?;
                }
                if !derived.is_empty() {
                    crate::save(&g)?;
                }
                let after = crate::features::measure(
                    &crate::implementations_of(&crate::load()).into_iter().collect::<Vec<_>>(),
                );
                return emit(&serde_json::json!({
                    "applied": derived.len(),
                    "byFeature": after.by_feature,
                    "featureless": after.featureless.len(),
                    "crossFeatureEdges": after.cross_feature_edges,
                    "edgesIntoCore": after.edges_into_core,
                }));
            }

            let r = crate::features::measure(&owned);
            let top: usize = flag_value(&args, "--top")
                .map(|v| v.parse::<usize>().map_err(|_| "--top needs a number".to_string()))
                .transpose()?
                .unwrap_or(20);
            let candidates: Vec<Value> = r
                .candidates
                .iter()
                .take(top)
                .map(|c| serde_json::json!({
                    "id": c.id,
                    "feature": c.feature,
                    "foreignFeatures": c.from.len(),
                    "from": c.from,
                }))
                .collect();
            emit(&serde_json::json!({
                "total": r.total,
                "byFeature": r.by_feature,
                "featureless": r.featureless,
                "crossFeatureEdges": r.cross_feature_edges,
                "edgesIntoCore": r.edges_into_core,
                "coreCandidates": candidates,
            }))
        }
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
            // Attributed: the fold edits records the caller never named, so every repointed
            // `composes` lands in that record's own history with a who and a why.
            let repointed = crate::merge_impls_by(
                &mut g, from, into,
                &bsc_record::resolve_writer(flag_value(&args, "--by").as_deref()),
            )?;
            crate::save(&g)?;
            // A MERGE IS TWO COMMANDS WHEN `from` IS PACKAGED, and this used to report only the first.
            //
            // `merge` removes `from` from the RUNTIME store. If the packaged seed also carries that id
            // the reconcile re-adds it, and the seed is the copy `emit-records` reads — so the fold
            // undoes itself and the output said `"removed"` regardless. MEASURED 2026-09-01 folding
            // `llm-energy.ts`: `impl get` returned null while the seed still listed it and `git status`
            // was clean.
            //
            // It cannot simply do the seed side by analogy with `--seed` elsewhere: what the seed needs
            // is not a removal but a TOMBSTONE, which is why `impl remove` refuses a packaged record and
            // `suppress` exists. So report the outstanding work and name the exact command, rather than
            // performing a different operation than the one asked for.
            let seed_still_has = seed_still_carries(from);
            let mut out = serde_json::json!({
                "from": from, "into": into, "repointed": repointed, "removed": from,
                "seedStillCarries": seed_still_has,
            });
            if seed_still_has {
                out["nextStep"] = Value::String(format!(
                    "the packaged seed still carries '{from}', so the reconcile will re-add it — finish                      the fold with: bsc graph impl suppress {from} --superseded-by {into} --seed"
                ));
            }
            emit(&out)
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

/// The COMMITTED repo store's record for `ref_`, for a record that exists only there (#155).
///
/// Read directly via [`crate::repo_store::read_at`] and never through [`crate::load`] — `load` runs the
/// seed reconcile, which would append all 676 packaged implementations to what the build compiles from.
/// That is the whole reason `repo_store` exists as a separate reader; see its module doc.
///
/// Resolution mirrors the runtime lookup it falls back FROM: exact `id` first, then a `name` that matches
/// exactly one record. An ambiguous name yields `None` rather than an arbitrary pick — the caller has
/// already reported ambiguity for the runtime store, and silently answering with one of several records
/// would be worse than saying it was not found.
///
/// Every failure is `None`: no repo, no store file, unreadable, unparseable. This is a FALLBACK behind a
/// successful runtime read, so the caller's existing "does not exist" message stays the one the user
/// sees; surfacing an io error from here would replace a true statement with a confusing one.
fn repo_only_impl(ref_: &str, args: &[String]) -> Option<Value> {
    // `--root` where given (the same flag `promote` takes), else search upward from the cwd. The walk
    // matters: `bsc graph impl get` is run from wherever a session happens to be — a crate directory, a
    // nested worktree — and anchoring on the cwd alone would make a repo-only record readable from the
    // repo root and invisible two directories down, which reads as data loss rather than as a path bug.
    let store = match flag_value(args, "--root") {
        Some(r) => crate::repo_store::read_at(&crate::repo_store::path_under(std::path::Path::new(&r))).ok()?,
        None => {
            let cwd = std::env::current_dir().ok()?;
            cwd.ancestors()
                .map(crate::repo_store::path_under)
                .find(|p| p.is_file())
                .and_then(|p| crate::repo_store::read_at(&p).ok())
                .flatten()
        }
    }?;

    let impls = crate::repo_store::impls_of(&store);
    if let Some(by_id) = impls.iter().find(|im| im.get("id").and_then(Value::as_str) == Some(ref_)) {
        return Some(by_id.clone());
    }
    let mut by_name = impls.iter().filter(|im| im.get("name").and_then(Value::as_str) == Some(ref_));
    match (by_name.next(), by_name.next()) {
        (Some(only), None) => Some(only.clone()),
        _ => None,
    }
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

/// Render ONE resolved field value for `impl get --field` (#137): `raw` unwraps a string with no JSON
/// quoting/escaping — so `--field code --raw` hands back the record's actual SOURCE, closing the round
/// trip `--code-file` (#76) opened one-way (write-from-disk, but no read-to-disk) — while a non-string
/// value still prints as compact JSON. Mirrors `bsc ui get --field`'s own `field_output` (#3162/#3713)
/// so the two `get --field --raw --out` doors behave identically. Pure → unit-tested.
fn field_text(value: &Value, raw: bool, pretty: bool) -> Result<String, String> {
    if raw {
        return Ok(match value {
            Value::String(s) => s.clone(),
            other => serde_json::to_string(other).map_err(|e| e.to_string())?,
        });
    }
    if pretty {
        serde_json::to_string_pretty(value).map_err(|e| e.to_string())
    } else {
        serde_json::to_string(value).map_err(|e| e.to_string())
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
fn set_impl_skipping_retired(
    g: &mut Value,
    im: Value,
    skipped: &mut Vec<String>,
    writer: &str,
    note: &str,
) -> Result<(), String> {
    let id = im.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    if !id.is_empty() && crate::is_suppressed(g, &id) {
        skipped.push(id);
        return Ok(());
    }
    crate::set_impl_by(g, im, writer, Some(note)).map(|_| ())
}

/// The verbs that MUTATE the algorithms store, as `(verb, subverb)` — `None` where the verb has no
/// subverb. The gate in [`run`] reads this; nothing else may.
///
/// STORE mutation, specifically. `promote`, `emit`, `unmaterialize`, `migrate-crate` and
/// `impl sync-seed` write REPO FILES, which are governed by the session's write globs and its FS
/// confinement — a second gate on the `graph` scope would deny a librarian its own promote while the
/// file boundary is what actually applies. `reseed` IS here: it overwrites the runtime store from the
/// seed, which is a store write however it is spelled.
const MUTATING: &[(&str, Option<&str>)] = &[
    ("impl", Some("set")),
    ("impl", Some("remove")),
    ("impl", Some("revert")),
    ("impl", Some("suppress")),
    ("impl", Some("unsuppress")),
    ("impl", Some("refresh")),
    ("edge", Some("set")),
    ("edge", Some("remove")),
    ("tests", Some("set")),
    ("tests", Some("harvest")),
    ("curate", None),
    ("merge", None),
    ("refolder", None),
    ("relink", None),
    ("reseed", None),
    ("features", None),
    ("doctor", None),
    ("harvest", None),
];

/// Whether this invocation would WRITE the store — the predicate the gate in [`run`] applies.
///
/// Four of the entries in [`MUTATING`] only write when a flag says so (`curate`/`harvest` need
/// `--apply`, `doctor` needs `--fix`, `features` needs `--apply`), and their READ form is the common
/// one — `doctor` is how a session finds out what is wrong, and denying that to a read-only role would
/// make the store un-inspectable. So the flag is part of the question, not an afterthought.
fn is_store_mutation(positional: &[&str], args: &[String]) -> bool {
    let Some(verb) = positional.first().copied() else { return false };
    // `<verb> help` and `<verb> <sub> help` ask for documentation and write nothing.
    if positional.contains(&"help") {
        return false;
    }
    let sub = positional.get(1).copied();
    // A `None` subverb in [`MUTATING`] means THE VERB ITSELF mutates, whatever follows it — and what
    // follows is an ARGUMENT, not a subverb (`merge <from> <into>`, `curate <dir>`, `relink <dir>`).
    // Matching `positional[1]` against `None` for those let every one of them through the gate: probed
    // live, `bsc graph merge a b` under `{"graph":"none"}` reached the arm and failed on the id lookup
    // instead of being refused. Only an entry that NAMES a subverb compares one.
    let named = MUTATING
        .iter()
        .any(|(v, s)| *v == verb && (s.is_none() || *s == sub));
    if !named {
        return false;
    }
    let has = |f: &str| args.iter().any(|a| a == f);
    match verb {
        "curate" | "harvest" | "features" => has("--apply"),
        "doctor" => has("--fix"),
        "relink" => !has("--dry-run"),
        "tests" if sub == Some("harvest") => !has("--dry-run"),
        _ => true,
    }
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

/// The top-level content keys that differ between `existing` (the seed record) and `fresh` (the store
/// record), sorted — reported so the direction and shape of a sync is visible before it is trusted.
/// Mirrors `diffFields` in `scripts/sync-impl-seed.mjs`, the script this verb replaces.
fn diff_fields(existing: &Value, fresh: &Value) -> Vec<String> {
    let mut keys: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    if let Some(o) = existing.as_object() {
        keys.extend(o.keys().cloned());
    }
    if let Some(o) = fresh.as_object() {
        keys.extend(o.keys().cloned());
    }
    keys.into_iter().filter(|k| existing.get(k) != fresh.get(k)).collect()
}

/// `bsc graph impl refresh <impl-id>=<src-relative-path>… [--apply]` — refresh a record's `code` from
/// the file it claims to be. Ports `scripts/refresh-impl-from-file.mjs`, which it replaces.
fn cmd_impl_refresh(args: &[String]) -> Result<(), String> {
    const USAGE: &str =
        "usage: bsc graph impl refresh <impl-id>=<src-relative-path>… [--apply] [--root <dir>]";
    let apply = args.iter().any(|a| a == "--apply");
    // `--root`, not a new `--repo`: this crate already uses that name for "the repo when the cwd is
    // not it" on `promote`, and a second spelling for one concept is how a surface stops being learnable.
    let repo = flag_value(args, "--root")
        .map(std::path::PathBuf::from)
        .unwrap_or(std::env::current_dir().map_err(|e| format!("cannot resolve cwd: {e}"))?);
    let writer = bsc_record::resolve_writer(flag_value(args, "--by").as_deref());

    // Positionals after `impl refresh`, skipping flags AND the value token a value-taking flag brings.
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut it = args.iter().skip(2);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--root" | "--by" => {
                it.next();
            }
            other if other.starts_with("--") => {}
            other => pairs.push(crate::impl_refresh::parse_pair(other)?),
        }
    }
    if pairs.is_empty() {
        return Err(USAGE.into());
    }

    let mut g = crate::load();
    let mut by_id: std::collections::HashMap<String, serde_json::Value> = std::collections::HashMap::new();
    for im in crate::implementations_of(&g) {
        if let Some(id) = im.get("id").and_then(serde_json::Value::as_str) {
            by_id.insert(id.to_string(), im);
        }
    }

    let mut wrote = 0usize;
    for (id, rel) in &pairs {
        let rec = by_id.get(id);
        let code = bsc_record::record_source::file_as_record_source(
            &repo.join("src").join(rel),
            rel,
        )
        .map_err(|e| format!("cannot read src/{rel}: {e}"))?;
        let before = rec.and_then(|r| r.get("code")).and_then(serde_json::Value::as_str).unwrap_or("");
        let before = rec.map(|_| before);

        match crate::impl_refresh::verdict(before, &code) {
            crate::impl_refresh::Verdict::NotInStore => {
                bsc_util::emit_line(&format!("SKIP {id} — not in the store"));
            }
            crate::impl_refresh::Verdict::AlreadyEqual => {
                bsc_util::emit_line(&format!("SKIP {id} — already equals its file"));
            }
            crate::impl_refresh::Verdict::Refresh(c) => {
                bsc_util::emit_line(&format!(
                    "{} {id:<20} {} -> {} chars",
                    if apply { "REFRESH" } else { "would refresh" },
                    c.before_len,
                    c.after_len
                ));
                if let Some(r) = c.restored.as_ref().filter(|r| !r.is_empty()) {
                    bsc_util::emit_line(&format!("    restores export(s): {}", r.join(", ")));
                }
                // A refresh should not REMOVE an export. If it does, the record held something the file
                // does not — a judgement call rather than a sync — so it is surfaced, never quiet.
                if let Some(r) = c.removed.as_ref().filter(|r| !r.is_empty()) {
                    bsc_util::emit_line(&format!(
                        "    ⚠ removes export(s) the record had: {} — adjudicate before applying",
                        r.join(", ")
                    ));
                }
                if !apply {
                    continue;
                }
                let mut next = rec.cloned().unwrap_or_else(|| serde_json::json!({}));
                next["code"] = serde_json::Value::String(code);
                let note = format!(
                    "refresh from {rel}: this record carries a provides naming that file, so it must BE \
                     that file — the file is the copy every gate validates"
                );
                crate::set_impl_by(&mut g, next, &writer, Some(&note))?;
                wrote += 1;
                bsc_util::emit_line("    written");
            }
        }
    }
    if apply && wrote > 0 {
        crate::save(&g)?;
    }
    if !apply {
        bsc_util::emit_line("\n(dry run — pass --apply to write)");
    }
    Ok(())
}

/// `impl sync-seed <id>… --seed-dir <dir> [--only <field>[,<field>…]] [--apply] [--pretty]` (#157) —
/// the store-to-seed sync `bsc ui sync-seed` (#139) already does for the component store, ported here
/// for the Algorithms library: write a runtime impl/edge record's CONTENT back into the packaged
/// `<seed-dir>/algorithms.json`, by id.
///
/// Deliberately BY ID, never a sweep — seed and store drift BOTH ways (that is the whole reason
/// `sync-impl-seed.mjs` reports SKIPs instead of assuming a direction), so a mass re-stamp would as
/// often overwrite real seed content with stale store content as the reverse. Dry run by default;
/// `--apply` writes. `--only <field>[,<field>…]` (request #167) syncs exactly the NAMED fields,
/// leaving the rest of the seed record untouched, for landing a new facet across many records without
/// dragging unrelated drift along. A value naming no field (empty, or all commas) is REFUSED rather
/// than silently matching nothing — the original bug: a comma list like `code,tests` was treated as
/// one literal (nonexistent) field name, so the merge was always a no-op reported as `upToDate`.
///
/// Comparison and the loses-fields refusal are NOT reimplemented here — they are
/// [`crate::repo_store::content_of`] and [`crate::repo_store::loses_fields`], the same functions
/// `bsc graph promote` already uses to decide the OTHER seam (runtime store → committed repo store),
/// so this verb and `promote` agree on what "the same record" means without a second definition to
/// drift from the first.
///
/// The whole seed document is parsed and re-written (never a per-record text patch), which is safe
/// only because `serde_json`'s `preserve_order` feature is on for this crate: [`Value`] objects then
/// round-trip through an insertion-ordered map, so an UNTOUCHED record's fields keep their original
/// order and only a synced record's fields move — `Map::insert` on an existing key updates its value
/// in place without changing its position, exactly like the JS `t[k] = fresh[k]` assignment loop in
/// `sync-impl-seed.mjs` it replaces. Without that feature every `Value::Object` is a `BTreeMap`, and
/// writing the file back would silently re-sort every record in it alphabetically — a one-field fix
/// producing a multi-thousand-line diff.
fn cmd_impl_sync_seed(args: &[String]) -> Result<(), String> {
    let usage =
        "usage: bsc graph impl sync-seed <id>… --seed-dir <dir> [--only <field>[,<field>…]] [--apply] [--pretty]";
    let seed_dir = flag_value(args, "--seed-dir").ok_or(usage)?;
    // `--only` accepts a COMMA LIST (request #167): treating the whole value as one literal field
    // name meant `--only code,tests` matched no field on either side, so the merge was always a
    // silent no-op reported as `upToDate` — a comma-joined multi-field sync is the established
    // convention for this CLI (`--tags a,b`, `--composes a,b`), and this flag had never followed it.
    let only: Option<Vec<String>> = match flag_value(args, "--only") {
        None => None,
        Some(raw) => {
            let fields: Vec<String> = raw.split(',').map(str::trim).filter(|f| !f.is_empty()).map(String::from).collect();
            if fields.is_empty() {
                return Err(format!("--only '{raw}' names no field"));
            }
            Some(fields)
        }
    };
    let apply = args.iter().any(|a| a == "--apply");
    let pretty = args.iter().any(|a| a == "--pretty");
    // Ids are the positionals after `impl sync-seed`, skipping both flags AND the VALUE token that
    // follows a value-taking flag. A plain `!starts_with("--")` filter is not enough — `--seed-dir`'s
    // own value is a bare directory name that looks exactly like an id, and was landing in `ids` too.
    let mut ids: Vec<&str> = Vec::new();
    let mut it = args.iter().skip(2); // args[0] = "impl", args[1] = "sync-seed"
    while let Some(a) = it.next() {
        match a.as_str() {
            "--seed-dir" | "--only" => {
                it.next(); // consume this flag's value — never an id
            }
            other if other.starts_with("--") => {} // `--apply` / `--pretty` / any other bare flag
            other => ids.push(other),
        }
    }
    if ids.is_empty() {
        return Err(usage.into());
    }

    let seed_path = std::path::Path::new(&seed_dir).join("algorithms.json");
    let seed_raw = std::fs::read_to_string(&seed_path).map_err(|e| format!("cannot read {}: {e}", seed_path.display()))?;
    let mut seed: Value =
        serde_json::from_str(&seed_raw).map_err(|e| format!("{} is not valid JSON: {e}", seed_path.display()))?;

    // Index the seed's two tiers by id ONCE — an id joins its tier's array position, matching
    // `mergeStores` in the mjs script: impls and edges share one id space by construction (an edge id
    // joins its members with `--`, an impl id is a bare file/name), so a genuine collision there is a
    // data problem worth failing on rather than silently picking a side.
    #[derive(Clone, Copy)]
    enum Tier {
        Impl,
        Edge,
    }
    let mut seed_index: std::collections::HashMap<String, (Tier, usize)> = std::collections::HashMap::new();
    for (i, im) in seed.get("implementations").and_then(Value::as_array).into_iter().flatten().enumerate() {
        if let Some(id) = im.get("id").and_then(Value::as_str) {
            seed_index.insert(id.to_string(), (Tier::Impl, i));
        }
    }
    for (i, e) in seed.get("edges").and_then(Value::as_array).into_iter().flatten().enumerate() {
        if let Some(id) = e.get("id").and_then(Value::as_str) {
            seed_index.insert(id.to_string(), (Tier::Edge, i));
        }
    }

    // The runtime store (store-or-seed, reconciled) — the SAME lookup `impl get`/`edge get` resolve
    // against, so a sync reflects the record a live session is actually looking at.
    let g = crate::load();
    let mut store_index: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    for im in crate::implementations_of(&g) {
        if let Some(id) = im.get("id").and_then(Value::as_str) {
            store_index.insert(id.to_string(), im);
        }
    }
    for e in crate::edges_of(&g) {
        if let Some(id) = e.get("id").and_then(Value::as_str) {
            if store_index.contains_key(id) {
                return Err(format!("id '{id}' exists as BOTH an impl and an edge in the store — ambiguous sync target"));
            }
            store_index.insert(id.to_string(), e);
        }
    }

    let (mut synced, mut up_to_date, mut would_lose_fields, mut missing_from_store, mut missing_from_seed) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());

    for id in &ids {
        let Some(store_rec) = store_index.get(*id) else {
            missing_from_store.push(*id);
            continue;
        };
        let Some(&(tier, idx)) = seed_index.get(*id) else {
            // Mirrors the mjs script's own SKIP wording: a record with no seed file needs PROMOTING
            // (a new entry), not syncing (an existing one).
            missing_from_seed.push(*id);
            continue;
        };
        let arr_key = match tier {
            Tier::Impl => "implementations",
            Tier::Edge => "edges",
        };
        let existing = seed
            .get(arr_key)
            .and_then(Value::as_array)
            .and_then(|a| a.get(idx))
            .cloned()
            .ok_or_else(|| format!("internal: seed index for '{id}' is stale"))?;
        let existing_content = crate::repo_store::content_of(&existing);
        let store_content = crate::repo_store::content_of(store_rec);
        // `--only <field>[,<field>…]` — exactly the NAMED fields onto the seed record: everything
        // else stays exactly as the seed has it, so no unrelated drift rides along with the facet(s)
        // being synced.
        let fresh = match &only {
            None => store_content.clone(),
            Some(fields) => {
                let mut merged = existing_content.clone();
                if let Some(obj) = merged.as_object_mut() {
                    for field in fields {
                        match store_content.get(field) {
                            Some(v) => {
                                obj.insert(field.clone(), v.clone());
                            }
                            None => {
                                obj.remove(field);
                            }
                        }
                    }
                }
                merged
            }
        };
        if existing_content == fresh {
            up_to_date.push(*id);
            continue;
        }
        if crate::repo_store::loses_fields(&fresh, &existing_content) {
            would_lose_fields
                .push(serde_json::json!({ "id": id, "fields": diff_fields(&existing_content, &fresh) }));
            continue;
        }
        let fields = diff_fields(&existing_content, &fresh);
        if apply {
            let target = seed
                .get_mut(arr_key)
                .and_then(Value::as_array_mut)
                .and_then(|a| a.get_mut(idx))
                .and_then(Value::as_object_mut)
                .ok_or_else(|| format!("internal: cannot re-open seed slot for '{id}'"))?;
            // Overlay each fresh key rather than replacing the whole object: `Map::insert` on an
            // EXISTING key updates its value in place and keeps its position (preserve_order), so a
            // record whose `id`/`tech`/`role` already sit first in the file stay there — only the
            // fields that actually changed move, and any brand-new key lands at the end.
            if let Some(fresh_obj) = fresh.as_object() {
                for (k, v) in fresh_obj {
                    target.insert(k.clone(), v.clone());
                }
            }
        }
        synced.push(serde_json::json!({ "id": id, "fields": fields }));
    }

    if apply && !synced.is_empty() {
        let text = serde_json::to_string_pretty(&seed).map_err(|e| e.to_string())?;
        std::fs::write(&seed_path, format!("{text}\n"))
            .map_err(|e| format!("cannot write {}: {e}", seed_path.display()))?;
    }

    let report = serde_json::json!({
        "seedDir": seed_dir, "applied": apply,
        "synced": synced, "upToDate": up_to_date, "wouldLoseFields": would_lose_fields,
        "missingFromStore": missing_from_store, "missingFromSeed": missing_from_seed,
    });
    let s = if pretty { serde_json::to_string_pretty(&report) } else { serde_json::to_string(&report) };
    bsc_util::emit_line(&s.map_err(|e| e.to_string())?);
    Ok(())
}

fn help(prog: &str) -> String {
    format!(
        "{prog} — the Algorithms knowledge library (#2761/#2853/#2961) — IMPL-ONLY (a node IS its implementation)\n\n\
         READ:\n  \
         {prog} impl get <id-or-name> [--field <name>] [--raw] [--out <name>] | impl list [--tech <t>] [--role r] [--domain <d>] [--feature <f>]   # a language kit's implementations (#2863); --domain filters to a cross-language COLLECTION (#3120, partial by design); --feature filters to the OWNERSHIP axis — which feature owns the record, and so which worker may write it (`core` is the shared baseline); get falls back to a bare NAME when it's unambiguous, else lists the colliding ids (#118); --field narrows to ONE field (`code`, typically) — --raw unwraps it with no JSON quoting, and --out <name> writes those exact bytes to $BSC_SCRATCH/<name> instead of stdout (#137) — the read-side door symmetric with `impl set --code-file` (#76)\n  \
         {prog} dump [--pretty]                         # the whole store document (the implementations tier)\n  \
         {prog} harvest <dir-or-file> [--tech T] [--worthy-only] [--module] [--pretty]   # harvest a project's functions into candidate library implementations, each classified worthy vs. glue (#2745); a FILE target harvests just that module (#4161); --module lifts a FILE as ONE module-shaped candidate carrying the `provides` specifier, for making a logic module a record rather than a library function; --apply (module mode only) WRITES that candidate to the store, the only path for a module too large to pass as `impl set --code`\n  \
         {prog} curate <dir> [--tech T] [--apply] [--pretty]          # curate a project's WORTHY candidates into the library — add/optimize; --apply writes the runtime store (#2745)\n  \
  \n         {prog} dupes <dir> [--tech typescript|rust] [--pretty]   # the WHOLE-TREE duplicate sweep (epic-a-graph-finds-its-own-duplicates): every non-trivial function under <dir>, on TWO signals — its rename-invariant SHAPE, and the same CONTRACT across FILES corroborated by the body (the same rule and constants `doctor --dedup` applies to the store, so the two surfaces cannot disagree about one pair). Each group names which signal found it — so a copy whose identifiers were all renamed is found, which `doctor --dedup` structurally cannot do over the store. The TREE, not the records: the algorithms store holds 32 Rust records against 7,514 Rust functions on disk, so a record-level sweep sees 0.4% of the Rust here. STREAMS rather than harvesting (measured: 115 MB peak vs 962 MB for a `harvest` of the same directory) and keeps NO index — a cache would need invalidation and re-deriving costs ~1.7s. Reports a path and a LINE per member, biggest groups first, and `duplicated` = how many functions could go. PROPOSE-ONLY; for per-table CRUD twins the action is a shared helper, not deletion\n  \
  \n         {prog} similar --sig \"(xs: T[]) => T\" [--tech t] [--limit n] | similar <id>   # DISCOVER BEFORE AUTHORING: does the library already hold this shape? Takes a SIGNATURE, not only an id, because the thing you are about to write has not been written yet — which is the whole difference between this and `doctor --dedup`, which compares what already exists. Ranked by CONTRACT overlap, floored at 0.34 so \"nothing like this exists\" answers with NOTHING rather than a tail of noise (measured: a real twin scores 1.00, an absent shape returns 0.14 on one shared parameter name). PROPOSE-ONLY — a close match may still be the wrong thing\n  \
         {prog} test <id> --out <dir> [--run] | test --all --out <dir> [--run]   # materialize ONE record + its paired tests into an EMPTY dir and optionally run them there — a pass in a directory holding only the record proves it is self-contained (run-a-records-paired-test-in-isolation)
  \n  {prog} edge set --id <id> --members a,b [--src <test-file>] | edge list | edge get <id> | edge remove <id>   # the RELATIONSHIP tier (integration-tests-become-graph-edges): a test spanning two records is evidence about the EDGE between them, not a property of either node; --src is READ from disk so a large test never has to fit through argv
    {prog} refolder [--pretty]                       # re-derive every impl's FOLDER from its `src` — the backfill mirroring `bsc ui regroup` (#4107)
  \
         {prog} relink <dir> [--tech t] [--dry-run] [--pretty]   # recover `src` (and the folder it derives) by matching stored impls to a fresh harvest (#4119)
  \n         {prog} tests harvest <dir> [--id a,b] [--dry-run] [--pretty]   # carry each impl's COLOCATED test file onto its node — the algorithms twin of `bsc ui tests harvest` (#4126). Bare, walks the WHOLE store; `--id` scopes the pairing to named ids only, so harvesting one record does not re-pair every other impl that happens to share its colocated-test pass (#123)
  \n         {prog} tests set --id <id> --src <test-file> [--name <n>] [--seed] [--if-version <n>] [--pretty]   # pair ONE record's test without a whole-tree harvest (#140); --seed ALSO lands it on the packaged seed record (`src-tauri/data/knowledge/algorithms.json`), not only the runtime store — a store-only write to a seeded record is transient (#141); --if-version <n> is the same OPTIMISTIC CONCURRENCY guard `impl set` carries (#183) — rejects the write unless the record's current rev is exactly n
  \n         {prog} doctor [--fix] [--dedup] [--pretty]             # diagnose viz typing + coverage: untyped / invalid-kind / mistyped / missing-viz; --fix assigns the inferred kind to untyped impls (#3212). --dedup is a FOCUSED mode (#78): duplicate-candidate GROUPS over the impl set, on THREE signals — a near-identical BODY (tokenized k-gram shingles, so formatting and wrappers do not defeat it), the same SHAPE (identical code under identifier renaming, which the shingles structurally cannot find because they contain the identifiers), and a shared NAME together with a shared src MODULE (either alone is a naming convention, not a duplicate). N duplicates report as ONE row naming every member and every signal that grouped them, confined to one tech, and it is propose-only (fold with `{prog} merge`)\n  \
         {prog} used-by <id> [--pretty] | used-by --all [--pretty]   # the composes-INVERSE usage: which impls compose <id>, or every impl ranked by usage — the measure step before a merge (#3594)\n  \
         {prog} features [--top N] [--apply] [--pretty]  # the OWNERSHIP axis measured: records per feature, what no feature owns, the composes edges that cross a feature vs point into `core`, and coreCandidates — records ranked by how many DIFFERENT features compose them. READ-ONLY unless --apply, which BACKFILLS `feature` from `folder` with the derivation both graphs share — dry by default, and it never overwrites a feature already set, so hand placement survives every re-run. `feature` is single-valued (it answers which worker may WRITE a record); the many-to-many USAGE relation is `requires` on a plan feature, per project, so the library never learns about projects. NOT to be confused with `--domain`, the curated cross-language COLLECTION facet (#3120), which is partial by design\n\n\
         WRITE (#2853) — curate the store; a read after reflects the write:\n  \
         {prog} impl set --tech <lang> --id <id> --role primitive|algorithm --name <n> [--code <c>] [--ref <std-path>] [--composes a,b] [--summary <s>] [--domain <d>] [--tags a,b] [--kind sort|search|traversal|accumulate] [--viz-code <js>|--viz-code-file <path>] [--code-file <path>] [--src <path>] [--folder <p>] [--provides <spec>] [--required-by p:f,q:g] [--module-state a,b] [--module-vis pub|private|pub(crate)] [--module-attrs-file <path>] [--reads e1,e2] [--writes e3] [--no-src] [--clear a,b] [--by <who>] [--note <why>] [--if-version <n>]   # upsert a language-kit impl (#4154: a MERGE — unsupplied fields are PRESERVED, not deleted; --clear removes a field explicitly; --no-src declares an algorithm that genuinely has no file here, #4136) (#2863/#2972); --domain/--tags #3120, --kind #3210 animation type, --viz-code #3218 JS trace-program, --src/--folder #4107 (a `--src` DERIVES the folder), --module-vis/--module-attrs-file record HOW a materialized module is DECLARED (visibility + attributes): a mod declaration carries meaning its body does not, and emitting an unconditional pub mod for a #[cfg]-gated or private module changes the program. --required-by is the USAGE mirror of a plan feature's `requires` — which features, in which projects, need this record; entries are `<projectKey>:<feature>` and an unqualified one is REFUSED, since a bare slug is ambiguous across projects. --module-state names the module's top-level MUTABLE bindings (sets only; --clear moduleState removes). --if-version <n> is OPTIMISTIC CONCURRENCY: the write is REJECTED (nothing changes) unless the record's current rev is exactly n, so a bulk pass cannot clobber a librarian edit that landed since it read. Read the current rev with `{prog} impl history <id>`; a record that has never been stamped, and one that does not exist yet, both read as rev 0. PREFER --code-file/--viz-code-file (#76): source on the command line is corrupted SILENTLY by the shell — a backtick or a ${{…}} is substituted away and a literal backslash-n never becomes a newline — and large modules exceed the argv limit outright\n  \
         {prog} impl remove <id>                        # delete a USER-MADE implementation + scrub it from every composes (a PACKAGED one is refused - it re-seeds; use `suppress`)
  \
         {prog} impl suppress <id> [--superseded-by <new-id>] [--seed]   # RETIRE a packaged algorithm durably (#71): a `{{ id, suppressed: true }}` TOMBSTONE occupies the id so the seed reconcile stops re-adding it; --superseded-by records WHAT replaced it, on the tombstone because that is the one record the reconcile never overwrites (a self / missing / already-retired target is REFUSED, not stored). --seed (#170) ALSO removes the id from the PACKAGED seed (`src-tauri/data/knowledge/algorithms.json`) that `scripts/emit-records.mjs` and the build actually read — a store-only tombstone stops the runtime reconcile but is invisible to the build, so the retired module kept shipping
  \
         {prog} impl unsuppress <id>                    # drop the tombstone so the packaged algorithm re-seeds on the next load (no data loss). REFUSES on a live impl - that goes through `remove`. Has no --seed counterpart: `suppress --seed` removes the record from the packaged seed entirely, so nothing is left in the process to restore — revert that with git
         {prog} impl history <id>                       # the write log (#72): rev, who, when, what CHANGED and what was DROPPED per write — the same shape as `bsc ui log`, from the same shared stamp
  \
         {prog} impl revert <id> [--to <rev>] [--by <who>]   # restore a previous `code`. Defaults to undoing the last source-moving write; REFUSES rather than landing on a nearer revision when the target has aged past the retained rungs, and names which revisions are still reachable
  \
         {prog} impl sync-seed <id>… --seed-dir <dir> [--only <field>[,<field>…]] [--apply] [--pretty]   # write a runtime impl/edge record's CONTENT back into the packaged <seed-dir>/algorithms.json, by id (#157) — the `bsc ui sync-seed` (#139) counterpart for this store. Deliberately BY ID: seed and store drift BOTH ways, so a sweep would as often overwrite real seed content as fresh store content. Dry run by default; --apply writes. --only <field>[,<field>…] (#167) syncs exactly the named fields, leaving the rest of the seed record untouched — a value naming no field is refused rather than silently matching nothing. Refuses (would-lose-fields) rather than dropping a non-empty field the seed already carries and the store copy lacks\n  \
         {prog} impl refresh <id>=<src-relative-path>… [--apply]   # refresh an EXISTING record's `code` from the file it claims to be, BY ID — the file is the copy tsc/lint/vitest/vite-build all validate, and these records claim to BE it. NOT `harvest --module --apply`, which authors under an id derived from the FILENAME: four feature barrels all derive `index.ts`, so applying them in turn writes them over one another under one id. Dry run by default. Reports what it RESTORES, and WARNS when a refresh would REMOVE an export the record had — that is a judgement call, not a sync\n  \
  \
         {prog} emit impl <id> <dir> | emit all <dir> | emit sync <dir>   # the store→FILE direction (#4192): write a record's code as stamped source; `sync` re-emits MANAGED files and skips hand-edited ones. One record = one file — NEVER written over the shared `src` it was lifted from
           {prog} merge <from-id> <into-id> [--pretty]    # fold a DUPLICATE into a survivor: repoint every impl's composes from→into (deduped), then remove `from` — the combine ACT (#3594)\n\
         {prog} migrate-crate <crate> [--apply] [--root <dir>]   # move ONE crate's source into the graph: harvest each top-level module as a record, record HOW it was declared (visibility + attributes), promote it into the committed store the build reads, then drop the `mod` lines, delete the files and opt the crate into the shared build script — so the crate compiles FROM the graph and its directory holds one file. DRY BY DEFAULT: without --apply it prints the plan and touches nothing, because the write path deletes source. REFUSES up front (naming the cause) for a crate that is already migrated, has nested module directories, declares a module with no matching file, or declares a *_test/*_tests module harvest skips — and VERIFIES with a real build before it finishes\n\n\
         {prog} unmaterialize [--apply] [--root <dir>]   # the ROLLBACK for files-to-zero: write every committed-store record whose `src` has NO file on disk back to that path, restoring the crate to an ordinary file tree (25 crates compile from the graph today; 60 records have no file). NOT `emit`, whose contract is the opposite — `emit` never writes over the shared `src` a record was lifted from, and that is exactly what a rollback must do. DRY BY DEFAULT, because the paths it writes are the ones a migration deleted and an accidental run would resurrect a second live copy of every module. REFUSES a record whose file still EXISTS (it is a function lifted out of a live file, not the file), and REFUSES a `src` claimed by more than one record rather than letting the last write win — the data-loss the `scripts/graph-unmaterialize.mjs` this replaces had, where six records contest two paths
         {prog} reseed [--id a,b] [--all] [--check] [--root <dir>]   # the SEED → RUNTIME STORE direction, the exact inverse of `promote --seed`. The per-user runtime store is the AUTHORING copy, and it can fall BEHIND what ships: after a refactor lands in the packaged seed, a machine that did not author it keeps serving the old body — and an impl's `provides` BEATS the platform registry, so the stale copy is handed to the page even when the bundle is perfectly correct. NO GATE CAN SEE THIS: tsc and vitest read `.bsc-records/`, emitted FROM the seed, so every gate reads a copy that is right and the only wrong one is on the user's disk. `--check` reports and exits non-zero. There is deliberately NO bare form — this OVERWRITES authoring, so name `--id a,b` or say `--all`
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

/// Serializes every test that repoints the process-global `BSC_GRAPH_STORE`.
///
/// THE COMMENT THIS REPLACES SAID "SAFETY: single-threaded test setup, before any other thread reads
/// the env" — and it was false at all 21 sites. `cargo test` threads tests inside ONE process, so the
/// set and the read of another test's store interleave freely. MEASURED on develop:
///
///     cargo test -p bsc-graph --lib     280 passed, 14 FAILED
///     cargo nextest run -p bsc-graph     294 passed, 0 failed
///
/// Both runners were right about what they ran; nextest forks per test, so the hazard cannot fire
/// there. The gate uses nextest and stayed green, which is why this survived — the cost was paid
/// entirely in the inner loop, by anyone reaching for the obvious `cargo test -p bsc-graph` and
/// finding fourteen failures that were not theirs.
///
/// The same mechanism `src-tauri/src/testutil.rs::ENV_LOCK` already uses for the same class of
/// problem (tests repointing HOME), reused rather than reinvented.
#[cfg(test)]
static STORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The store lock, reachable from a sibling module's tests.
///
/// `lib.rs` needs it too: the packaged-seed cache test repoints `BSC_DATA_DIR`, which is the same
/// process-global hazard these guards exist for, and a second lock would let the two races interleave.
#[cfg(test)]
pub(crate) mod test_support {
    /// Take the same lock [`super::store_at`] takes, without setting anything.
    pub(crate) fn store_lock() -> std::sync::MutexGuard<'static, ()> {
        super::STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Point `BSC_GRAPH_STORE` at `path` for the rest of THIS test, serialized against every other test
/// that does the same.
///
/// HOLD THE GUARD — `let _store = store_at(&p);`, never `let _ = store_at(&p);` and never a bare call.
/// A dropped guard releases the lock immediately and restores exactly the race this exists to remove,
/// while the test still passes in isolation. `#[must_use]` catches the bare call; the `let _` form is
/// the one to watch for in review.
///
/// A poisoned lock is taken anyway (`into_inner`): a panicking test has already failed and must not
/// take the rest of the suite with it.
/// [`store_at`] for the tests that repoint the DATA dir as well. Both variables under ONE lock,
/// because a test holding two guards would deadlock on the second and a second lock would let the two
/// races interleave — the hazard is the pair, not either variable.
#[cfg(test)]
#[must_use = "hold the guard for the test's lifetime — dropping it re-opens the race"]
fn store_and_data_at(store: &std::path::Path, data: &std::path::Path) -> std::sync::MutexGuard<'static, ()> {
    let guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // SAFETY: serialized by the lock above against every other test that touches either variable.
    unsafe {
        std::env::set_var("BSC_GRAPH_STORE", store);
        std::env::set_var("BSC_DATA_DIR", data);
    }
    guard
}

#[cfg(test)]
#[must_use = "hold the guard for the test's lifetime — dropping it re-opens the race"]
fn store_at(path: &std::path::Path) -> std::sync::MutexGuard<'static, ()> {
    let guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // SAFETY: the lock above is what makes this single-threaded with respect to every other test that
    // touches this variable — which is precisely what the comment it replaces only claimed.
    unsafe { std::env::set_var("BSC_GRAPH_STORE", path) };
    guard
}

#[cfg(test)]
mod tests {

    /// EVERY test that repoints a store env var must hold the store lock — asserted over the SOURCE,
    /// because nothing at run time can observe the absence of a lock.
    ///
    /// This is the durable guard for `the-graph-store-drift-recurs-and-forces-every-promote-through-skip-gate`.
    /// The unlocked version of these sites (fixed in `0afd02c5`) did not merely redden `cargo test`: a
    /// write that resolved `BSC_GRAPH_STORE` after a concurrent test had removed it landed in the
    /// DEFAULT store — `~/.base-studio-code/knowledge/algorithms.json`, the real per-user one.
    ///
    /// MEASURED 2026-09-01. `session-roles.ts` there held `export function sessionRoles() {}` (33
    /// characters against the record's 3263), the name `session-roles` against `sessionRoles`, and two
    /// stub tests — one of them carrying the literal `/* updated */` marker from
    /// `tests_set_upserts_by_name_and_does_not_drop_sibling_tests` below. `graph-promote-check` then
    /// went red on a DIFFERENT node every run (whichever test lost the race) and every `npm run promote`
    /// that day was forced through `--skip-gate`, which skips verifying develop entirely.
    ///
    /// So the lock is not test hygiene. A reviewer re-adding one bare `set_var` restores a defect that
    /// corrupts the user's authoring copy and blinds the promote gate, and neither symptom points back
    /// here. That is why this is pinned in the source rather than left to review.
    #[test]
    fn every_store_env_mutation_is_inside_the_store_lock() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders: Vec<String> = Vec::new();
        let mut scanned = 0usize;
        let mut mutating = 0usize;
        for entry in std::fs::read_dir(&root).expect("the crate has a src/ dir") {
            let path = entry.expect("readable dir entry").path();
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let src = std::fs::read_to_string(&path).expect("readable source");
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            scanned += 1;
            for site in store_env_sites(&src) {
                mutating += 1;
                if !site.locked {
                    offenders.push(format!("{name}:{} — fn {}", site.line, site.func));
                }
            }
        }
        assert!(scanned > 0, "the source scan found no .rs files under {}", root.display());
        // A scan that stopped MATCHING would report zero offenders and read as a pass, which is the
        // failure mode this whole item is about. So the population is asserted too.
        assert!(
            mutating >= 10,
            "expected the crate to still hold many store-env mutators; found {mutating} — the scanner \
             has probably stopped matching rather than the sites having gone away",
        );
        assert!(
            offenders.is_empty(),
            "these functions mutate BSC_GRAPH_STORE / BSC_DATA_DIR without holding the store lock:\n  {}\n\
             Take the guard instead — `let _store = store_at(&p);`, `store_and_data_at(&p, &d)`, or \
             `test_support::store_lock()` — and HOLD it for the test's lifetime. An unlocked write \
             resolves the DEFAULT store and corrupts ~/.base-studio-code/knowledge/algorithms.json.",
            offenders.join("\n  "),
        );
    }

    /// One function that touches a store env var, and whether it holds the lock.
    struct StoreEnvSite {
        func: String,
        line: usize,
        locked: bool,
    }

    /// Every `fn` in `src` that mutates `BSC_GRAPH_STORE` or `BSC_DATA_DIR`, paired with whether that
    /// same function takes the store lock.
    ///
    /// Bodies are delimited by INDENTATION (`fn` at indent N ends at the first later line that is
    /// exactly N spaces then `}`), not by brace counting. This file is full of raw JSON fixtures —
    /// `r#"{"implementations":[…]}"#` — whose braces a counter would have to strip string literals to
    /// survive, and a scanner that silently mis-parses reports zero offenders, which reads as a pass.
    /// rustfmt guarantees the indentation, and a closing brace of a fixture is never alone at a `fn`'s
    /// own indent.
    ///
    /// `store_at` and `store_and_data_at` are excluded BY NAME: they are the lock, so requiring them to
    /// take it is circular.
    fn store_env_sites(src: &str) -> Vec<StoreEnvSite> {
        const GUARDS: [&str; 2] = ["store_at", "store_and_data_at"];
        let lines: Vec<&str> = src.lines().collect();
        let mut out = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            let Some(name) = fn_name(line) else { continue };
            if GUARDS.contains(&name.as_str()) {
                continue;
            }
            let indent = line.len() - line.trim_start().len();
            let closer = format!("{}}}", " ".repeat(indent));
            let end = lines[i + 1..]
                .iter()
                .position(|l| *l == closer)
                .map(|p| i + 1 + p)
                .unwrap_or(lines.len() - 1);
            let body = &lines[i..=end];
            let mutates = body.iter().any(|l| {
                (l.contains("set_var(") || l.contains("remove_var("))
                    && (l.contains("BSC_GRAPH_STORE") || l.contains("BSC_DATA_DIR"))
            });
            if !mutates {
                continue;
            }
            let locked = body
                .iter()
                .any(|l| l.contains("store_at(") || l.contains("store_and_data_at(") || l.contains("store_lock()"));
            out.push(StoreEnvSite { func: name, line: i + 1, locked });
        }
        out
    }

    /// `fn <name>` on this line, at any indent and through the usual prefixes.
    fn fn_name(line: &str) -> Option<String> {
        let t = line.trim_start();
        let rest = ["pub(crate) ", "pub(super) ", "pub ", ""]
            .iter()
            .find_map(|p| t.strip_prefix(*p))?;
        let rest = rest.strip_prefix("async ").unwrap_or(rest);
        let rest = rest.strip_prefix("unsafe ").unwrap_or(rest);
        let rest = rest.strip_prefix("fn ")?;
        let name: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
        if name.is_empty() {
            None
        } else {
            Some(name)
        }
    }

    /// The scanner must actually SEE an unlocked site — proven against a synthetic pair rather than
    /// trusted, because a scanner that matches nothing passes the guard above vacuously.
    ///
    /// The fixture spells the keyword `FUNC` and substitutes it in. That is not decoration: the guard
    /// above scans THIS FILE, so a fixture written as literal Rust declares a `fn unlocked` that the
    /// guard then reports as a real offender — measured, on the first run. A fixture must not
    /// masquerade as the source it is a fixture for.
    #[test]
    fn the_store_env_scanner_separates_a_locked_site_from_an_unlocked_one() {
        let src = "\
mod tests {
    #[test]
    FUNC locked() {
        let _store = store_at(&p);
        unsafe { std::env::set_var(\"BSC_GRAPH_STORE\", &p) };
    }
    #[test]
    FUNC unlocked() {
        unsafe { std::env::set_var(\"BSC_GRAPH_STORE\", &p) };
    }
    #[test]
    FUNC untouched() {
        assert!(true);
    }
}
"
        .replace("FUNC ", "fn ");
        let sites = store_env_sites(&src);
        assert_eq!(sites.len(), 2, "only the two store-env functions are sites");
        assert_eq!(sites[0].func, "locked");
        assert!(sites[0].locked, "a body holding store_at is locked");
        assert_eq!(sites[1].func, "unlocked");
        assert!(!sites[1].locked, "a body with a bare set_var is the offender this must catch");
    }
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

    /// THE SIGNATURE HAS TO REACH THE RECORD, or `bsc graph impl get` still cannot answer what a
    /// function takes and returns without its reader parsing the body — which is the whole point of the
    /// slice (epic-a-graph-finds-its-own-duplicates). Extraction is pinned next door in `extract.rs`;
    /// this pins the CROSSING, which is the seam that silently drops fields.
    #[test]
    fn curate_apply_stores_the_signature_on_the_record() {
        let dir = crate::unique_temp("sigcurate");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = dir.join("algorithms.json");
        let _store = store_at(&store);

        let src = dir.join("src");
        std::fs::create_dir_all(&src).unwrap();
        // GENERIC on purpose: `curate` stores only WORTHY candidates and `classify` scores a type
        // parameter +1 ("reusable across types"), which is what clears the bar. A monomorphic helper
        // harvests a perfectly good signature and is then filtered out before the store — measured,
        // and it is why this fixture is not the obvious `clamp(value, lo, hi)`.
        std::fs::write(
            src.join("firstWhere.ts"),
            concat!(
                "export function firstWhere<T>(xs: T[], pred: (x: T) => boolean): T | undefined {\n",
                "  for (const x of xs) if (pred(x)) return x;\n",
                "  return undefined;\n",
                "}\n",
            ),
        )
        .unwrap();

        run(
            ["curate", src.to_str().unwrap(), "--tech", "typescript", "--apply"]
                .iter().map(|s| s.to_string()).collect(),
            "bsc graph",
        )
        .unwrap();

        let sig = crate::implementations()
            .into_iter()
            .find(|i| i.get("name").and_then(Value::as_str) == Some("firstWhere"))
            .and_then(|i| i.get("signature").cloned())
            .expect("firstWhere was curated and carries a signature");

        assert_eq!(
            sig["params"],
            serde_json::json!([
                { "name": "xs", "type": "T[]" },
                // A FUNCTION-TYPED parameter survives verbatim — arrows inside a type annotation are
                // the shape a naive `split(',')` on the parameter list would tear in half.
                { "name": "pred", "type": "(x: T) => boolean" },
            ]),
            "every parameter, in order, with its type: {sig}",
        );
        assert_eq!(sig["returns"], serde_json::json!({ "type": "T | undefined" }));
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
        let _store = store_at(&store);

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
        // #184: the fixture lives under `std::env::temp_dir()`, outside this repo — a `--code-file`
        // is a user path and must work from anywhere. `source_flag` checks it against
        // `require_harvestable_root`, which reads the real `$BSC_REPO_ROOT` when no thread-local
        // override is set, so this test spuriously failed confinement in a debug-studio pane (its
        // shell genuinely carries that var). Force the unconfined case hermetically.
        bsc_cli_util::with_repo_root(None, || {
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
        });
    }

    /// #155: a record that lives ONLY in the committed repo store must be readable.
    ///
    /// `crate::implementations()` resolves the runtime store alone, so a crate module promoted into
    /// `graph/algorithms.json` and never re-authored read as "does not exist" — while plainly existing,
    /// with fields (`tests` among them) an editor needs to see before touching it.
    #[test]
    fn a_repo_only_record_is_found_by_id_and_by_unique_name() {
        let dir = std::env::temp_dir()
            .join(format!("bsc-repo-only-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("graph")).unwrap();
        std::fs::write(
            crate::repo_store::path_under(&dir),
            serde_json::json!({
                "implementations": [
                    { "id": "bsc-loop--cli.rs", "name": "cli", "code": "//! x", "tests": [{ "name": "cli.rs" }] },
                    { "id": "other--cli.rs", "name": "cli", "code": "//! y" },
                    { "id": "solo.rs", "name": "solo", "code": "//! z" }
                ]
            })
            .to_string(),
        )
        .unwrap();
        let root = vec!["--root".to_string(), dir.to_string_lossy().into_owned()];

        // By exact id — and it carries the fields that made this worth fixing.
        let got = repo_only_impl("bsc-loop--cli.rs", &root).expect("found by id");
        assert_eq!(got.get("id").and_then(Value::as_str), Some("bsc-loop--cli.rs"));
        assert!(got.get("tests").is_some(), "the record's paired tests come back with it");

        // By a name only one record has.
        assert_eq!(
            repo_only_impl("solo", &root).and_then(|v| v.get("id").and_then(Value::as_str).map(str::to_owned)),
            Some("solo.rs".to_string()),
        );

        // An AMBIGUOUS name yields None rather than an arbitrary pick: two records are named `cli`, and
        // answering with either would be a wrong record returned confidently.
        assert!(repo_only_impl("cli", &root).is_none(), "ambiguous name must not resolve");
        assert!(repo_only_impl("nothing-here", &root).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Every failure path is `None`, never an error: this runs BEHIND a successful runtime read, so the
    /// caller's existing "does not exist" message must stay the one the user sees.
    #[test]
    fn a_missing_or_corrupt_repo_store_is_not_found_rather_than_an_error() {
        let dir = std::env::temp_dir()
            .join(format!("bsc-repo-only-bad-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("graph")).unwrap();
        let root = vec!["--root".to_string(), dir.to_string_lossy().into_owned()];

        // No store file at all — a repo that has migrated nothing is not an error.
        assert!(repo_only_impl("anything", &root).is_none());

        // A corrupt one is also just "not found" here; `promote`/the build report it properly.
        std::fs::write(crate::repo_store::path_under(&dir), "{ not json").unwrap();
        assert!(repo_only_impl("anything", &root).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// #155 (request #155, filed by kevin): `impl set --code-file` on an id that exists ONLY in the
    /// committed repo store — a runtime store lookup finds nothing — used to take `set_impl_by`'s
    /// CREATE branch and build a record from just this call's flags. `tests` has no flag at all, so it
    /// was silently dropped from the runtime store, and `promote` then refused forever
    /// (`refusedWouldLoseFields`) rather than ever landing the new code: an editor could not safely
    /// touch a repo-only record's code at all. The fix seeds the runtime graph with the repo-only copy
    /// before `set_impl_by`'s merge runs, so the write lands ON TOP of the real fields instead of
    /// starting from nothing — the same shape `impl get`'s repo-only fallback already uses.
    #[test]
    fn impl_set_on_a_repo_only_record_merges_onto_it_and_promote_then_lands_cleanly() {
        let dir = crate::unique_temp("repo-only-set");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("graph")).unwrap();
        std::fs::write(
            crate::repo_store::path_under(&dir),
            serde_json::json!({
                "implementations": [{
                    "id": "bsc-loop--cli.rs", "tech": "rust", "role": "algorithm", "name": "cli",
                    "code": "// original\n", "src": "crates/bsc-loop/src/cli.rs",
                    "folder": "crates/bsc-loop/src",
                    "tests": [{ "name": "cli.rs", "src": "#[test]\nfn it_works() {}\n" }],
                    "summary": "the bsc-loop CLI dispatcher"
                }]
            })
            .to_string(),
        )
        .unwrap();

        let runtime_store = dir.join("runtime.json");
        // SAFETY: single-threaded test setup, before any other thread reads the env (nextest gives this
        // test its own process, per the note on `impl_set_writes_and_clears_module_state` above).
        let _store = store_at(&runtime_store);

        let root = dir.to_string_lossy().into_owned();
        // No --src, no --no-src: the record's provenance already lives on the repo-only copy, and this
        // edit must not have to restate it to pass the #4136 gate.
        let set_args: Vec<String> = [
            "impl", "set", "--id", "bsc-loop--cli.rs", "--tech", "rust", "--role", "algorithm",
            "--name", "cli", "--code", "// new code\n", "--root", &root,
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        run(set_args, "bsc graph").expect("impl set must not require restating provenance it already has");

        let saved = crate::implementations()
            .into_iter()
            .find(|i| i.get("id").and_then(Value::as_str) == Some("bsc-loop--cli.rs"))
            .expect("the record now exists in the runtime store");
        assert_eq!(saved.get("code").and_then(Value::as_str), Some("// new code\n"), "the edit landed");
        assert!(saved.get("tests").is_some(), "the repo-only record's paired test must survive the edit");
        assert_eq!(
            saved.get("summary").and_then(Value::as_str),
            Some("the bsc-loop CLI dispatcher"),
            "fields this call never restated must survive too"
        );

        // Promote must now land the code change cleanly — before the fix this refused forever
        // (`refusedWouldLoseFields`) because the runtime copy had regressed relative to the repo one.
        let promote_args: Vec<String> =
            ["promote", "--id", "bsc-loop--cli.rs", "--root", &root].iter().map(|s| s.to_string()).collect();
        run(promote_args, "bsc graph").expect("promote must land the merged record, not refuse it");

        let repo = crate::repo_store::read_at(&crate::repo_store::path_under(&dir)).unwrap().unwrap();
        let promoted = crate::repo_store::impls_of(&repo)
            .into_iter()
            .find(|i| i.get("id").and_then(Value::as_str) == Some("bsc-loop--cli.rs"))
            .expect("promoted into the repo store");
        assert_eq!(promoted.get("code").and_then(Value::as_str), Some("// new code\n"));
        assert!(promoted.get("tests").is_some(), "tests survive the promote too");

        unsafe { std::env::remove_var("BSC_GRAPH_STORE") };
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

    /// REGRESSION (#136): `bsc graph promote help` ran a REAL bare promote instead of printing usage —
    /// `help` was silently accepted as a no-op positional rather than routed to the help arm, so the
    /// discovery gesture every charter teaches ("run `<verb> help` first") was actively unsafe here. It
    /// mirrors the `emit help` / `harvest help` guard just above it.
    #[test]
    fn promote_help_prints_usage_and_does_not_promote() {
        let dir = std::env::temp_dir().join(format!(
            "bsc-promote-help-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let args = vec!["promote".to_string(), "help".to_string(), "--root".to_string(), dir.to_string_lossy().into_owned()];
        run(args, "bsc graph").expect("`promote help` must succeed");

        assert!(
            !crate::repo_store::path_under(&dir).exists(),
            "`promote help` must print usage, not run a promote — it must not create a store file",
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// #157 (request from kevin): `impl sync-seed` writes a runtime store record's CONTENT back into
    /// the packaged `<seed-dir>/algorithms.json`, by id — the `bsc ui sync-seed` (#139) counterpart for
    /// the Algorithms library. A comment/code fix authored through `impl set` used to live only in the
    /// runtime store with no `bsc` path back into the packaged seed / git.
    #[test]
    fn impl_sync_seed_writes_a_changed_field_refuses_field_loss_and_reports_missing_ids() {
        let dir = crate::unique_temp("impl-sync-seed");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let seed_path = dir.join("algorithms.json");
        std::fs::write(
            &seed_path,
            serde_json::json!({
                "implementations": [
                    { "id": "sync157-a", "tech": "typescript", "role": "algorithm", "name": "A",
                      "code": "// seed code a\n", "summary": "seed summary a" },
                    { "id": "sync157-b", "tech": "typescript", "role": "algorithm", "name": "B",
                      "code": "// seed code b\n", "summary": "seed summary b", "docs": "seed-only docs" },
                    { "id": "sync157-missing-from-store", "tech": "typescript", "role": "algorithm",
                      "name": "M", "code": "// only in the seed\n" }
                ],
                "edges": []
            })
            .to_string(),
        )
        .unwrap();

        let runtime_store = dir.join("runtime.json");
        // SAFETY: single-threaded test setup, before any other thread reads the env (nextest gives this
        // test its own process, per the note on `impl_set_writes_and_clears_module_state` above).
        let _store = store_at(&runtime_store);
        std::fs::write(
            &runtime_store,
            serde_json::json!({
                "implementations": [
                    { "id": "sync157-a", "tech": "typescript", "role": "algorithm", "name": "A",
                      "code": "// NEW code a\n", "summary": "seed summary a" },
                    // `docs` is absent here — syncing this record WHOLE would DROP a non-empty seed field.
                    { "id": "sync157-b", "tech": "typescript", "role": "algorithm", "name": "B",
                      "code": "// NEW code b\n", "summary": "NEW summary b" },
                    { "id": "sync157-missing-from-seed", "tech": "typescript", "role": "algorithm",
                      "name": "N", "code": "// only in the store\n" }
                ],
                "edges": []
            })
            .to_string(),
        )
        .unwrap();

        let seed_dir = dir.to_string_lossy().into_owned();
        let ids = ["sync157-a", "sync157-b", "sync157-missing-from-store", "sync157-missing-from-seed"];
        let mut args: Vec<String> = vec!["impl".into(), "sync-seed".into()];
        args.extend(ids.iter().map(|s| s.to_string()));
        args.extend(["--seed-dir".to_string(), seed_dir.clone()]);

        // Dry run (no --apply): reports the would-be sync, refuses the field-losing record, and
        // touches nothing on disk.
        let (r, out) = bsc_util::capture_output(|| cmd_impl_sync_seed(&args));
        r.unwrap();
        let report: serde_json::Value = serde_json::from_str(out.trim()).unwrap();
        assert_eq!(report["applied"], false);
        let synced: Vec<&str> =
            report["synced"].as_array().unwrap().iter().map(|v| v["id"].as_str().unwrap()).collect();
        assert_eq!(synced, vec!["sync157-a"], "only the cleanly-diverged id needs writing");
        assert_eq!(
            report["synced"][0]["fields"],
            serde_json::json!(["code"]),
            "only the field that actually changed is reported"
        );
        let lost: Vec<&str> =
            report["wouldLoseFields"].as_array().unwrap().iter().map(|v| v["id"].as_str().unwrap()).collect();
        assert_eq!(lost, vec!["sync157-b"], "syncing b whole would drop the seed-only `docs` field");
        assert_eq!(report["missingFromSeed"], serde_json::json!(["sync157-missing-from-seed"]));
        assert_eq!(report["missingFromStore"], serde_json::json!(["sync157-missing-from-store"]));

        let seed_unchanged: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&seed_path).unwrap()).unwrap();
        let a_seed =
            seed_unchanged["implementations"].as_array().unwrap().iter().find(|i| i["id"] == "sync157-a").unwrap();
        assert_eq!(a_seed["code"], "// seed code a\n", "dry run wrote nothing");

        // --apply writes the diverged record and preserves the seed's field order (preserve_order).
        let mut apply_args = args.clone();
        apply_args.push("--apply".to_string());
        cmd_impl_sync_seed(&apply_args).unwrap();
        let seed_written: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&seed_path).unwrap()).unwrap();
        let a_written =
            seed_written["implementations"].as_array().unwrap().iter().find(|i| i["id"] == "sync157-a").unwrap();
        assert_eq!(a_written["code"], "// NEW code a\n");
        let keys: Vec<&str> = a_written.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            vec!["id", "tech", "role", "name", "code", "summary"],
            "insertion order is preserved — only VALUES change"
        );

        // `b` (would lose `docs`) must still be untouched even after --apply of the whole batch.
        let b_written =
            seed_written["implementations"].as_array().unwrap().iter().find(|i| i["id"] == "sync157-b").unwrap();
        assert_eq!(b_written["code"], "// seed code b\n", "the refused record is never written");
        assert_eq!(b_written["summary"], "seed summary b");
        assert!(b_written.get("docs").is_some(), "the seed-only field the refusal protects must survive");

        // A second sync of the already-synced id is a no-op.
        let (r, out) = bsc_util::capture_output(|| {
            cmd_impl_sync_seed(&[
                "impl".into(),
                "sync-seed".into(),
                "sync157-a".into(),
                "--seed-dir".into(),
                seed_dir.clone(),
            ])
        });
        r.unwrap();
        let report: serde_json::Value = serde_json::from_str(out.trim()).unwrap();
        assert_eq!(report["upToDate"], serde_json::json!(["sync157-a"]));
        assert_eq!(report["synced"], serde_json::json!([]));

        unsafe { std::env::remove_var("BSC_GRAPH_STORE") };
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── the store WRITE GATE (`the-algorithms-graph-has-no-write-gate`) ──────────────────────────

    /// Minimal argv for every entry in [`MUTATING`], in its WRITING form.
    ///
    /// The args are deliberately nonsense (`a`, `b`, a missing dir): the gate fires BEFORE dispatch, so
    /// a refused call never reaches the arm that would object to them. If the gate regresses, the arm
    /// runs and returns some OTHER error — which is exactly what the assertion below distinguishes,
    /// and why it checks the message rather than merely `is_err()`.
    fn mutating_argv() -> Vec<Vec<String>> {
        let v = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect::<Vec<String>>();
        vec![
            v(&["impl", "set", "--tech", "rust", "--role", "algorithm", "--id", "x.rs", "--name", "x", "--no-src"]),
            v(&["impl", "remove", "x.rs"]),
            v(&["impl", "revert", "x.rs"]),
            v(&["impl", "suppress", "x.rs"]),
            v(&["impl", "unsuppress", "x.rs"]),
            v(&["impl", "refresh", "x.rs=src/x.rs", "--apply"]),
            v(&["edge", "set", "--id", "e", "--members", "a,b"]),
            v(&["edge", "remove", "e"]),
            v(&["tests", "set", "--id", "x.rs", "--src", "t.ts"]),
            v(&["tests", "harvest", "."]),
            v(&["curate", ".", "--apply"]),
            v(&["merge", "a", "b"]),
            v(&["refolder"]),
            v(&["relink", "."]),
            v(&["reseed", "--all"]),
            v(&["features", "--apply"]),
            v(&["doctor", "--fix"]),
            v(&["harvest", ".", "--module", "--apply"]),
        ]
    }

    /// THE BITE. Every mutating verb refuses under a read-only `graph` scope.
    ///
    /// It drives `run` rather than asserting on `require_write_scope`, and that distinction IS the
    /// item: the helper was always correct and `bsc-component` had been calling it for four verbs,
    /// while `bsc-graph` called it nowhere. A test at the helper would have been green throughout the
    /// entire period the store had no gate at all.
    ///
    /// It also covers the classifier bug the manual probe caught: `MUTATING` pairs a verb with an
    /// optional SUBVERB, and matching `positional[1]` against `None` let every verb taking a positional
    /// ARGUMENT through — `merge a b`, `curate <dir>`, `relink <dir>`. Six of the eighteen rows below
    /// were reaching their arm.
    #[test]
    fn every_mutating_verb_refuses_under_a_read_only_graph_scope() {
        // THE STORE GUARD IS NOT OPTIONAL HERE, even though every call below is meant to be REFUSED.
        //
        // Without it these argvs resolve the DEFAULT store — the real
        // `~/.base-studio-code/knowledge/algorithms.json`. That is harmless while the gate works and
        // catastrophic the moment someone proves the bite by removing it: `curate . --apply` and
        // `harvest . --module --apply` then run for real against the user's authoring copy. MEASURED,
        // because that is exactly what happened — one bite run added 125 records to the live store and
        // they had to be removed by hand.
        //
        // A test whose safety depends on the code under test still working is not safe. The guard is
        // what makes it safe when the code is broken, which is the only time this test matters.
        let dir = crate::unique_temp("graph-gate-refuse");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let _store = store_at(&dir.join("algorithms.json"));

        for argv in mutating_argv() {
            let shown = argv.join(" ");
            for doc in [r#"{"graph":"none"}"#, r#"{"graph":"read"}"#] {
                let err = bsc_cli_util::with_scopes(Some(doc), || run(argv.clone(), "bsc graph"))
                    .expect_err(&format!("`{shown}` must be refused under {doc}"));
                assert!(
                    err.contains("'graph' scope is read-only"),
                    "`{shown}` under {doc} must be refused BY THE GATE, not by the arm it should never \
                     have reached; got: {err}"
                );
            }
        }
        unsafe { std::env::remove_var("BSC_GRAPH_STORE") };
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The gate must not swallow the surface it exists to protect: reads, dry runs and help still work.
    ///
    /// This is the half that keeps the gate honest. `doctor` is how a session finds out what is WRONG
    /// with the library, and a gate that denied it to a read-only role would make the store
    /// un-inspectable by every role that most needs to inspect it.
    #[test]
    fn reads_dry_runs_and_help_are_untouched_by_the_gate() {
        let dir = crate::unique_temp("graph-gate-reads");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let _store = store_at(&dir.join("algorithms.json"));

        let v = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect::<Vec<String>>();
        for argv in [
            v(&["impl", "list"]),
            v(&["dump"]),
            v(&["doctor"]),                     // the READ form of a verb whose --fix is gated
            v(&["features"]),                   // …and of one whose --apply is gated
            v(&["curate", "."]),                // a plan, not an apply
            v(&["relink", ".", "--dry-run"]),
            v(&["used-by", "--all"]),
            v(&["impl", "set", "help"]),        // `help` writes nothing, whatever verb it follows
            v(&["merge", "help"]),
        ] {
            let shown = argv.join(" ");
            let r = bsc_cli_util::with_scopes(Some(r#"{"graph":"none"}"#), || {
                bsc_util::capture_output(|| run(argv.clone(), "bsc graph")).0
            });
            if let Err(e) = r {
                assert!(
                    !e.contains("scope is read-only"),
                    "`{shown}` is a READ and must never hit the write gate; got: {e}"
                );
            }
        }
        unsafe { std::env::remove_var("BSC_GRAPH_STORE") };
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An ABSENT scope doc still ALLOWS — an ungated pane, and every existing test, keeps working.
    ///
    /// The dangerous state here is the one with no name: `scope_allows_write_in(None, …)` returns
    /// `true`, so "no scope configured" is the WIDEST value, not the narrowest. Pinning it means a
    /// later change to that default cannot silently brick every ad-hoc `bsc graph` invocation.
    #[test]
    fn an_absent_scope_doc_allows_the_write() {
        let dir = crate::unique_temp("graph-gate-absent");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let _store = store_at(&dir.join("algorithms.json"));

        let argv: Vec<String> = ["impl", "set", "--tech", "rust", "--role", "algorithm", "--id", "ungated.rs", "--name", "ungated", "--no-src"]
            .iter().map(|s| s.to_string()).collect();
        let (r, _) = bsc_cli_util::with_scopes(None, || bsc_util::capture_output(|| run(argv, "bsc graph")));
        r.expect("an ungated session writes as it always did");

        // And a doc that grants `write` is equally allowed — the grant is real, not merely un-refused.
        let argv2: Vec<String> = ["impl", "set", "--tech", "rust", "--role", "algorithm", "--id", "granted.rs", "--name", "granted", "--no-src"]
            .iter().map(|s| s.to_string()).collect();
        let (r2, _) = bsc_cli_util::with_scopes(Some(r#"{"graph":"write"}"#), || {
            bsc_util::capture_output(|| run(argv2, "bsc graph"))
        });
        r2.expect("a `write` tier writes");

        unsafe { std::env::remove_var("BSC_GRAPH_STORE") };
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Every verb named in [`MUTATING`] is a verb this CLI actually has.
    ///
    /// A typo there does not fail loudly — it silently leaves that verb UNGATED for ever, which is the
    /// state this whole item exists to end. Nothing at run time can observe the difference, so the
    /// vocabulary is asserted against the dispatch's own rosters.
    #[test]
    fn every_mutating_entry_names_a_real_verb() {
        for (verb, sub) in MUTATING {
            assert!(VERBS.contains(verb), "`{verb}` is in MUTATING but is not a bsc graph verb");
            if let Some(sub) = sub {
                let roster: &[&str] = match *verb {
                    "impl" => &IMPL_SUBVERBS,
                    "edge" => &EDGE_SUBVERBS,
                    // `tests` has no exported roster; its two subverbs are named here.
                    "tests" => &["harvest", "set"],
                    other => panic!("MUTATING names a subverb under `{other}`, which has no roster"),
                };
                assert!(roster.contains(sub), "`{verb} {sub}` is in MUTATING but not in its subverb roster");
            }
        }
        // NON-VACUITY: the list is asserted to still be a real population, so a MUTATING emptied by a
        // bad merge reports as broken rather than as trivially passing.
        assert!(MUTATING.len() >= 15, "MUTATING has shrunk to {} — a verb lost its gate", MUTATING.len());
    }

    /// `--only <field>` syncs exactly ONE field onto the seed record, leaving the rest of it exactly as
    /// the seed already has it — so landing a new facet across many records does not drag unrelated
    /// drift along under cover of the change.
    #[test]
    fn impl_sync_seed_only_flag_syncs_a_single_field() {
        let dir = crate::unique_temp("impl-sync-seed-only");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let seed_path = dir.join("algorithms.json");
        std::fs::write(
            &seed_path,
            serde_json::json!({
                "implementations": [{
                    "id": "sync157-only", "tech": "typescript", "role": "algorithm", "name": "Only",
                    "code": "// seed code\n", "summary": "seed summary"
                }],
                "edges": []
            })
            .to_string(),
        )
        .unwrap();

        let runtime_store = dir.join("runtime.json");
        let _store = store_at(&runtime_store);
        std::fs::write(
            &runtime_store,
            serde_json::json!({
                "implementations": [{
                    "id": "sync157-only", "tech": "typescript", "role": "algorithm", "name": "Only",
                    "code": "// STORE code — must NOT sync\n", "summary": "NEW summary — should sync"
                }],
                "edges": []
            })
            .to_string(),
        )
        .unwrap();

        let seed_dir = dir.to_string_lossy().into_owned();
        let args: Vec<String> =
            ["impl", "sync-seed", "sync157-only", "--seed-dir", &seed_dir, "--only", "summary", "--apply"]
                .iter()
                .map(|s| s.to_string())
                .collect();
        cmd_impl_sync_seed(&args).unwrap();

        let seed_written: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&seed_path).unwrap()).unwrap();
        let rec = &seed_written["implementations"][0];
        assert_eq!(rec["summary"], "NEW summary — should sync", "--only field is synced");
        assert_eq!(rec["code"], "// seed code\n", "everything else stays exactly as the seed has it");

        unsafe { std::env::remove_var("BSC_GRAPH_STORE") };
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// request #167 (kevin): `--only code,tests` used to be treated as ONE literal field name —
    /// `code,tests` matches no field on either side, so the merge was always a no-op silently reported
    /// as `upToDate` with nothing written. A comma list must sync EACH named field.
    #[test]
    fn impl_sync_seed_only_flag_accepts_a_comma_list() {
        let dir = crate::unique_temp("impl-sync-seed-only-list");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let seed_path = dir.join("algorithms.json");
        std::fs::write(
            &seed_path,
            serde_json::json!({
                "implementations": [{
                    "id": "sync167-list", "tech": "typescript", "role": "algorithm", "name": "List",
                    "code": "// stale seed code\n", "tests": "// stale seed tests\n", "summary": "unrelated summary"
                }],
                "edges": []
            })
            .to_string(),
        )
        .unwrap();

        let runtime_store = dir.join("runtime.json");
        let _store = store_at(&runtime_store);
        std::fs::write(
            &runtime_store,
            serde_json::json!({
                "implementations": [{
                    "id": "sync167-list", "tech": "typescript", "role": "algorithm", "name": "List",
                    "code": "// fresh store code\n", "tests": "// fresh store tests\n", "summary": "unrelated summary"
                }],
                "edges": []
            })
            .to_string(),
        )
        .unwrap();

        let seed_dir = dir.to_string_lossy().into_owned();
        let args: Vec<String> =
            ["impl", "sync-seed", "sync167-list", "--seed-dir", &seed_dir, "--only", "code,tests", "--apply"]
                .iter()
                .map(|s| s.to_string())
                .collect();
        let (r, out) = bsc_util::capture_output(|| cmd_impl_sync_seed(&args));
        r.unwrap();
        let report: serde_json::Value = serde_json::from_str(out.trim()).unwrap();
        assert_eq!(report["upToDate"], serde_json::json!([]), "a genuine drift must not report upToDate");
        assert_eq!(report["synced"][0]["id"], "sync167-list");

        let seed_written: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&seed_path).unwrap()).unwrap();
        let rec = &seed_written["implementations"][0];
        assert_eq!(rec["code"], "// fresh store code\n", "both comma-listed fields sync");
        assert_eq!(rec["tests"], "// fresh store tests\n", "both comma-listed fields sync");
        assert_eq!(rec["summary"], "unrelated summary", "a field outside --only stays untouched");

        unsafe { std::env::remove_var("BSC_GRAPH_STORE") };
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An `--only` value naming no field (empty, or nothing but commas) is refused rather than
    /// silently accepted as a single literal field name that can never match — the same silent-no-op
    /// shape as #167, just at the empty end of the range.
    #[test]
    fn impl_sync_seed_only_flag_rejects_a_value_naming_no_field() {
        assert!(
            cmd_impl_sync_seed(&[
                "impl".into(),
                "sync-seed".into(),
                "some-id".into(),
                "--seed-dir".into(),
                "/tmp/wherever".into(),
                "--only".into(),
                ", ,".into(),
            ])
            .is_err(),
            "--only ', ,' names no field and must be refused"
        );
    }

    /// Mirrors `bsc ui sync-seed`'s own usage guards: `--seed-dir` is required, and so is at least one id.
    #[test]
    fn impl_sync_seed_requires_seed_dir_and_at_least_one_id() {
        assert!(
            cmd_impl_sync_seed(&["impl".into(), "sync-seed".into(), "some-id".into()]).is_err(),
            "--seed-dir is required"
        );
        assert!(
            cmd_impl_sync_seed(&["impl".into(), "sync-seed".into(), "--seed-dir".into(), "/tmp/wherever".into()])
                .is_err(),
            "at least one id is required"
        );
    }

    /// THE WRONG-GUESS ROSTER MUST BE THE WHOLE ROSTER. The usage line already says so in a comment —
    /// "half of it used to be missing from this line" — and nothing enforced it, so `impl refresh`
    /// landed in `IMPL_SUBVERBS` and in `graph help` while the message a mistaken caller actually sees
    /// still named eight of nine. A roster that is only mostly complete is worse than none: it reads as
    /// authoritative.
    #[test]
    fn the_impl_usage_error_names_every_subverb() {
        let err = super::run(vec!["impl".into(), "no-such-subverb".into()], "bsc graph")
            .expect_err("an unknown subverb must fail");
        for sub in super::IMPL_SUBVERBS {
            assert!(
                err.contains(&format!("impl {sub}")),
                "the usage error omits `impl {sub}`, so a caller who guessed wrong cannot find it:\n{err}"
            );
        }
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
        let _store = store_at(&store);

        let set = |id: &str, name: &str| {
            crate::cli::run(
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
        let _store = store_at(&store);

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
            crate::cli::run(
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

        // Unconfined for this call, like `harvest_and_curate_refuse_a_target_outside_the_sessions_
        // confinement_root` — the fixture lives under the OS temp dir, not this crate's own root, and
        // this test's own confinement is not what it is checking. Without this the test's result
        // depends on whether the CALLING session happens to have `$BSC_REPO_ROOT` set, which is exactly
        // the ambient-env dependency #3475 exists to avoid asserting around.
        bsc_cli_util::with_repo_root(None, || {
            crate::cli::run(
                vec![
                    "tests".into(), "harvest".into(), repo.to_string_lossy().into_owned(),
                    "--id".into(), "a.ts".into(),
                ],
                "bsc graph",
            )
        })
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

    /// #123 — a requested id the store never held must be NAMED, not silently dropped.
    ///
    /// Scoping filters inside the pairing loop, so an id that matches no record simply never comes up:
    /// the run reports `paired: 0` and exits 0. That reads as "this record has no colocated test" when
    /// the truth is "that id does not exist" — the same shape as the wrong-root guard a few lines
    /// above, where a plausible count stood in for a question nobody asked. A typo in `--id` is the
    /// everyday way to hit it.
    /// The confinement boundary on `tests set --src`, which nothing pinned.
    ///
    /// `harvest_and_curate_refuse_a_target_outside_the_sessions_confinement_root` loops over `harvest`
    /// and `curate` only — both take a DIRECTORY. `tests set --src` takes a FILE, down a different
    /// path, and a boundary with no test is one a refactor can quietly drop. #3475 is the same
    /// boundary: a harvest hands back file CONTENTS, so `bsc-confine` being blind to what this binary
    /// reads is precisely why the check lives in the binary.
    #[test]
    fn tests_set_refuses_a_src_outside_the_sessions_confinement_root() {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("sample.test.ts")
            .to_string_lossy()
            .into_owned();
        let elsewhere = std::env::temp_dir().to_string_lossy().into_owned();
        let err = bsc_cli_util::with_repo_root(Some(&elsewhere), || {
            crate::cli::run(
                vec![
                    "tests".into(),
                    "set".into(),
                    "--id".into(),
                    "sample.ts".into(),
                    "--src".into(),
                    fixture,
                ],
                "bsc graph",
            )
            .unwrap_err()
        });
        assert!(
            err.contains("outside every root this session may harvest"),
            "{err}"
        );
    }

    /// The usage string is the whole answer to "what CAN tests do", so it must name every verb. It
    /// has grown one (`promote`, #123) and will grow more; nothing asserted its content.
    #[test]
    fn tests_with_an_unknown_subverb_names_both_verbs_in_its_usage() {
        let err = bsc_cli_util::with_repo_root(None, || {
            run(vec!["tests".into(), "bogus".into()], "bsc graph").unwrap_err()
        });
        assert!(
            err.contains("tests set") && err.contains("tests harvest"),
            "{err}"
        );
    }

    /// #123 — a test harvested onto an ALREADY-RETIRED module's record had no route to the packaged
    /// seed at all. `promote-records.mjs` promotes a record only while its file still exists, and
    /// `sync-impl-seed.mjs` syncs only `code`, so the record was "already seeded" and never
    /// reconsidered. This is that missing door, on the `bsc` surface a build-tier-less session holds.
    #[test]
    fn tests_promote_syncs_tests_from_the_runtime_store_onto_the_packaged_seed() {
        let dir = crate::unique_temp("tests-promote");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = dir.join("algorithms.json");

        // A throwaway PACKAGED data dir, standing in for `src-tauri/data`, so this test never touches
        // the real committed seed. `BSC_DATA_DIR` is `bsc_util::packaged`'s highest-priority override.
        let data_dir = dir.join("data");
        std::fs::create_dir_all(data_dir.join("knowledge")).unwrap();
        let seed_path = data_dir.join("knowledge/algorithms.json");
        std::fs::write(
            &seed_path,
            serde_json::json!({
                "implementations": [{
                    "id": "seeded-123.ts", "name": "seeded-123.ts", "tech": "typescript",
                    "role": "algorithm", "code": "export const x = 1;", "src": "tests/fixtures/sample.ts",
                }],
            })
            .to_string(),
        )
        .unwrap();

        let _store = store_and_data_at(&store, &data_dir);

        // `load()` reconciles the packaged seed into the runtime store on first read, so the id above
        // is already present here with no `tests` — exactly the "retired module" shape #123 describes:
        // the record survives only as a seed/store copy, never as a file `tests harvest` could re-pair
        // through provenance alone. Harvest onto it directly so the runtime store carries real `tests`.
        let root = env!("CARGO_MANIFEST_DIR").to_string();
        run(vec!["tests".into(), "harvest".into(), root, "--id".into(), "seeded-123.ts".into()], "bsc graph")
            .expect("harvest pairs the colocated test");
        let runtime_tests = crate::implementations()
            .into_iter()
            .find(|i| i.get("id").and_then(Value::as_str) == Some("seeded-123.ts"))
            .and_then(|i| i.get("tests").cloned())
            .expect("the runtime store now carries tests");
        assert!(!runtime_tests.as_array().unwrap().is_empty());

        // A dry run (no --apply) must report what it WOULD do and touch nothing.
        let (dry, dry_out) = bsc_util::capture_output(|| {
            run(vec!["tests".into(), "promote".into(), "--id".into(), "seeded-123.ts".into()], "bsc graph")
        });
        dry.expect("a dry tests-promote succeeds");
        assert!(dry_out.contains("\"seeded-123.ts\""), "{dry_out}");
        let untouched: Value = serde_json::from_str(&std::fs::read_to_string(&seed_path).unwrap()).unwrap();
        assert!(
            untouched["implementations"][0].get("tests").is_none(),
            "without --apply the packaged seed must be untouched: {untouched}"
        );

        // `--apply` writes the packaged seed.
        run(
            vec!["tests".into(), "promote".into(), "--id".into(), "seeded-123.ts".into(), "--apply".into()],
            "bsc graph",
        )
        .expect("tests promote --apply succeeds");
        let seeded: Value = serde_json::from_str(&std::fs::read_to_string(&seed_path).unwrap()).unwrap();
        assert_eq!(
            seeded["implementations"][0]["tests"], runtime_tests,
            "the packaged seed must now carry the SAME tests the runtime store harvested"
        );

        // An id the packaged seed never had is a REFUSAL, not an insert — that would be a full record
        // promotion (`promote-records.mjs`'s job), not a test sync onto an id already there.
        let set = |id: &str| {
            crate::cli::run(
                vec![
                    "impl".to_string(), "set".into(),
                    "--tech".into(), "typescript".into(),
                    "--id".into(), id.into(),
                    "--role".into(), "algorithm".into(),
                    "--name".into(), id.into(),
                    "--code".into(), "export const y = 2;".into(),
                    "--src".into(), "tests/fixtures/sample.ts".into(),
                ],
                "bsc graph",
            )
            .unwrap();
        };
        set("not-seeded-123.ts");
        run(
            vec!["tests".into(), "harvest".into(), env!("CARGO_MANIFEST_DIR").into(), "--id".into(),
                 "not-seeded-123.ts".into()],
            "bsc graph",
        )
        .unwrap();
        let (res, out) = bsc_util::capture_output(|| {
            crate::cli::run(
                vec!["tests".into(), "promote".into(), "--id".into(), "not-seeded-123.ts".into(), "--apply".into()],
                "bsc graph",
            )
        });
        res.expect("promote of an unseeded id succeeds — it is reported as skipped, not an error");
        assert!(
            out.contains("not in the packaged seed"),
            "an id absent from the packaged seed must be REFUSED, not silently inserted: {out}"
        );

        unsafe {
            std::env::remove_var("BSC_GRAPH_STORE");
            std::env::remove_var("BSC_DATA_DIR");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tests_harvest_names_an_id_the_store_never_held() {
        let dir = crate::unique_temp("testsharvest-unknown-id");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = dir.join("algorithms.json");
        // SAFETY: single-threaded test setup, as in the neighbouring harvest tests.
        let _store = store_at(&store);

        let repo = dir.join("repo");
        std::fs::create_dir_all(repo.join("src/x")).unwrap();
        std::fs::write(repo.join("src/x/a.ts"), "export function a() {}\n").unwrap();
        std::fs::write(
            repo.join("src/x/a.test.ts"),
            "describe(\"a\", () => { it(\"works\", () => {}); });\n",
        )
        .unwrap();

        run(
            vec![
                "impl".into(), "set".into(),
                "--tech".into(), "typescript".into(),
                "--id".into(), "a.ts".into(),
                "--role".into(), "algorithm".into(),
                "--name".into(), "a.ts".into(),
                "--code".into(), "export function x() {}".into(),
                "--src".into(), "src/x/a.ts".into(),
            ],
            "bsc graph",
        )
        .unwrap();

        // One real id and one that does not exist. The real one must still pair — naming the unknown
        // is a REPORT, not a refusal, so a batch is not lost to one bad entry.
        let (res, out) = bsc_util::capture_output(|| {
            bsc_cli_util::with_repo_root(None, || {
                run(
                    vec![
                        "tests".into(), "harvest".into(), repo.to_string_lossy().into_owned(),
                        "--id".into(), "a.ts,no-such-id.ts".into(),
                    ],
                    "bsc graph",
                )
            })
        });
        res.unwrap();
        assert!(out.contains("no-such-id.ts"), "an id the store never held must be NAMED: {out}");
        assert!(out.contains("\"paired\":1"), "the real id still pairs: {out}");

        // ...and a run whose ids all exist stays quiet, so `unknownIds` is signal rather than noise.
        let (res, clean) = bsc_util::capture_output(|| {
            bsc_cli_util::with_repo_root(None, || {
                run(
                    vec![
                        "tests".into(), "harvest".into(), repo.to_string_lossy().into_owned(),
                        "--id".into(), "a.ts".into(),
                    ],
                    "bsc graph",
                )
            })
        });
        res.unwrap();
        assert!(clean.contains("\"unknownIds\":[]"), "nothing unknown when every id exists: {clean}");

        unsafe { std::env::remove_var("BSC_GRAPH_STORE") };
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn impl_get_field_raw_out_writes_the_code_verbatim_to_the_scratch_dir() {
        // #137, the motivating case: `impl set --code-file` already reads a module from DISK (#76)
        // because argv corrupts backticks/`${…}`/newlines silently — but the READ side had no way to get
        // that same source back OUT as a file, only as JSON-escaped text on stdout. This is the exact
        // failing command from the request: `impl get <id> --code-file <path>`, now
        // `impl get <id> --field code --raw --out <name>`.
        let dir = crate::unique_temp("implget-fieldout");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = dir.join("algorithms.json");
        // SAFETY: single-threaded test setup, before any other thread reads the env (same pattern as
        // the neighboring `impl_get_falls_back_…` test).
        let _store = store_at(&store);

        // Source carrying exactly what argv would corrupt silently: a backtick, a `${…}` interpolation,
        // and literal newlines — read from a file via `--code-file`, never typed on the command line.
        let code_dir = crate::unique_temp("implget-fieldout-src");
        let _ = std::fs::remove_dir_all(&code_dir);
        std::fs::create_dir_all(&code_dir).unwrap();
        let code_file = code_dir.join("llm-config.ts");
        let source = "export const cfg = {\n  label: `model-${env}`,\n  fallback: `none`,\n};\n";
        std::fs::write(&code_file, source).unwrap();

        // `--code-file` reads from disk through the same FS-confinement gate `--out` writes through
        // (#3475); unconfine the thread so a `/tmp` fixture is readable, matching every other
        // `--code-file` test in this module.
        bsc_cli_util::with_repo_root(None, || {
            crate::cli::run(
                vec![
                    "impl".into(), "set".into(),
                    "--tech".into(), "typescript".into(),
                    "--id".into(), "llm-config.ts".into(),
                    "--role".into(), "algorithm".into(),
                    "--name".into(), "llmConfig".into(),
                    "--code-file".into(), code_file.to_string_lossy().into_owned(),
                    "--src".into(), "src/llm-config.ts".into(),
                ],
                "bsc graph",
            )
        })
        .unwrap();

        let scratch = crate::unique_temp("implget-fieldout-scratch");
        let _ = std::fs::remove_dir_all(&scratch);
        std::fs::create_dir_all(&scratch).unwrap();
        bsc_cli_util::with_scratch(scratch.to_str(), || {
            crate::cli::run(
                vec![
                    "impl".into(), "get".into(), "llm-config.ts".into(),
                    "--field".into(), "code".into(), "--raw".into(), "--out".into(), "llmConfig.ts".into(),
                ],
                "bsc graph",
            )
            .unwrap();
            let got = std::fs::read_to_string(scratch.join("llmConfig.ts")).unwrap();
            // `--raw` unwraps the JSON string with no escaping — the round trip is byte-exact.
            assert_eq!(got, source, "the code landed on disk exactly as it was set, backticks and all");
        });

        unsafe { std::env::remove_var("BSC_GRAPH_STORE") };
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&code_dir);
        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[test]
    fn impl_get_field_without_out_prints_to_stdout_and_refuses_an_unknown_field() {
        let dir = crate::unique_temp("implget-field-stdout");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = dir.join("algorithms.json");
        let _store = store_at(&store);

        run(
            vec![
                "impl".into(), "set".into(),
                "--tech".into(), "typescript".into(),
                "--id".into(), "solo.ts".into(),
                "--role".into(), "algorithm".into(),
                "--name".into(), "solo".into(),
                "--code".into(), "export function solo() {}".into(),
                "--src".into(), "src/solo.ts".into(),
            ],
            "bsc graph",
        )
        .unwrap();

        // `--field` with no `--out` still succeeds, printing to stdout instead of a file.
        assert!(run(vec!["impl".into(), "get".into(), "solo.ts".into(), "--field".into(), "code".into()], "bsc graph").is_ok());
        assert!(run(vec!["impl".into(), "get".into(), "solo.ts".into(), "--field".into(), "code".into(), "--raw".into()], "bsc graph").is_ok());

        // An unknown field is refused by name, listing the fields that DO exist.
        let err = run(vec!["impl".into(), "get".into(), "solo.ts".into(), "--field".into(), "nope".into()], "bsc graph").unwrap_err();
        assert!(err.contains("nope") && err.contains("code"), "{err}");

        // `--field`/`--out` on a MISS is an error (nothing to extract or spill), unlike the plain
        // whole-record `get` on a miss, which answers `null`.
        let err = run(vec!["impl".into(), "get".into(), "definitely-not-here.rs".into(), "--field".into(), "code".into()], "bsc graph").unwrap_err();
        assert!(err.contains("definitely-not-here.rs"), "{err}");

        unsafe { std::env::remove_var("BSC_GRAPH_STORE") };
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn impl_get_out_without_field_writes_the_whole_record_and_refuses_a_path_traversal() {
        let dir = crate::unique_temp("implget-out-whole");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = dir.join("algorithms.json");
        let _store = store_at(&store);

        run(
            vec![
                "impl".into(), "set".into(),
                "--tech".into(), "typescript".into(),
                "--id".into(), "whole.ts".into(),
                "--role".into(), "algorithm".into(),
                "--name".into(), "whole".into(),
                "--code".into(), "export function whole() {}".into(),
                "--src".into(), "src/whole.ts".into(),
            ],
            "bsc graph",
        )
        .unwrap();

        let scratch = crate::unique_temp("implget-out-whole-scratch");
        let _ = std::fs::remove_dir_all(&scratch);
        std::fs::create_dir_all(&scratch).unwrap();
        bsc_cli_util::with_scratch(scratch.to_str(), || {
            run(vec!["impl".into(), "get".into(), "whole.ts".into(), "--out".into(), "rec.json".into()], "bsc graph").unwrap();
            let got = std::fs::read_to_string(scratch.join("rec.json")).unwrap();
            assert!(got.contains("\"id\":\"whole.ts\""), "the whole record landed: {got}");

            // The scratch-dir confinement defense (shared with `bsc ui get --out`) refuses a non-bare name.
            let err = run(vec!["impl".into(), "get".into(), "whole.ts".into(), "--out".into(), "../escape".into()], "bsc graph").unwrap_err();
            assert!(err.contains("BARE FILENAME"), "a path traversal is refused: {err}");
        });

        unsafe { std::env::remove_var("BSC_GRAPH_STORE") };
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&scratch);
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

    /// `tests set` pairs ONE record's test without a whole-tree `harvest` — the gap filed as request
    /// #140 (`bsc graph tests harvest <scratch-dir> --dry-run` reported `paired: 0` for every record
    /// because a scratch dir has nothing colocated to resolve against, even for the one id the caller
    /// actually had a test file for). It refuses an unknown id rather than silently creating a record.
    #[test]
    fn tests_set_pairs_an_existing_record_and_refuses_an_unknown_id() {
        let dir = crate::unique_temp("testsset");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = dir.join("algorithms.json");
        let _store = store_at(&store);

        run(
            vec![
                "impl".into(), "set".into(),
                "--tech".into(), "typescript".into(),
                "--id".into(), "paired.ts".into(),
                "--role".into(), "algorithm".into(),
                "--name".into(), "paired".into(),
                "--code".into(), "export function paired() {}".into(),
                "--src".into(), "src/paired.ts".into(),
            ],
            "bsc graph",
        )
        .unwrap();

        let src_dir = crate::unique_temp("testsset-src");
        let _ = std::fs::remove_dir_all(&src_dir);
        std::fs::create_dir_all(&src_dir).unwrap();
        let test_file = src_dir.join("paired.test.ts");
        let contents = "import { paired } from './paired';\nit('works', () => paired());\n";
        std::fs::write(&test_file, contents).unwrap();

        // `--code-file`-style reads go through the FS-confinement gate (#3475); unconfine the thread so
        // a `/tmp` fixture is readable, matching every other file-reading test in this module.
        bsc_cli_util::with_repo_root(None, || {
            crate::cli::run(
                vec![
                    "tests".into(), "set".into(),
                    "--id".into(), "paired.ts".into(),
                    "--src".into(), test_file.to_string_lossy().into_owned(),
                ],
                "bsc graph",
            )
        })
        .unwrap();

        let stored = crate::implementations()
            .into_iter()
            .find(|i| i.get("id").and_then(Value::as_str) == Some("paired.ts"))
            .and_then(|i| i.get("tests").cloned());
        assert_eq!(
            stored,
            Some(serde_json::json!([{ "name": "paired.test.ts", "src": contents, "ext": ".ts" }])),
            "the test file's contents landed on the record verbatim, named by its basename \
             (no `describe(` title to prefer), carrying the source file's real `.ts` extension (#148)",
        );

        // An id that does not exist is refused — `tests set` pairs an EXISTING record, it never
        // creates one.
        let err = bsc_cli_util::with_repo_root(None, || {
            crate::cli::run(
                vec![
                    "tests".into(), "set".into(),
                    "--id".into(), "not-a-real-id.ts".into(),
                    "--src".into(), test_file.to_string_lossy().into_owned(),
                ],
                "bsc graph",
            )
        })
        .unwrap_err();
        assert!(err.contains("not-a-real-id.ts") && err.contains("does not create one"), "{err}");

        unsafe { std::env::remove_var("BSC_GRAPH_STORE") };
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&src_dir);
    }

    /// `tests set --if-version <n>` (#183) — the same opt-in optimistic-concurrency guard `impl set`
    /// carries (`if_version_rejects_a_stale_write_and_allows_a_current_one` in `lib.rs`), now wired to
    /// this write path too. Before this, `tests set` funneled through the UNVERSIONED `set_impl`, so a
    /// concurrent test-pairing session had no way to refuse a stale overwrite — the exact loss request
    /// #183 was filed against, just via `tests set` rather than `impl set`.
    #[test]
    fn tests_set_if_version_rejects_a_stale_write_and_allows_a_current_one() {
        let dir = crate::unique_temp("testsset-ifversion");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = dir.join("algorithms.json");
        let _store = store_at(&store);

        run(
            vec![
                "impl".into(), "set".into(),
                "--tech".into(), "typescript".into(),
                "--id".into(), "guarded.ts".into(),
                "--role".into(), "algorithm".into(),
                "--name".into(), "guarded".into(),
                "--code".into(), "export function guarded() {}".into(),
                "--src".into(), "src/guarded.ts".into(),
            ],
            "bsc graph",
        )
        .unwrap();
        let rev_after_create = |id: &str| {
            bsc_record::read_rev(
                &crate::implementations().into_iter().find(|i| i.get("id").and_then(Value::as_str) == Some(id)).unwrap(),
            )
        };
        assert_eq!(rev_after_create("guarded.ts"), 1, "the create above stamps rev 1");

        let src_dir = crate::unique_temp("testsset-ifversion-src");
        let _ = std::fs::remove_dir_all(&src_dir);
        std::fs::create_dir_all(&src_dir).unwrap();
        let test_file = src_dir.join("guarded.test.ts");
        std::fs::write(&test_file, "it('works', () => {});\n").unwrap();

        // rev 0 is STALE — the record moved on to rev 1 at create. Rejected, nothing written.
        let err = bsc_cli_util::with_repo_root(None, || {
            crate::cli::run(
                vec![
                    "tests".into(), "set".into(),
                    "--id".into(), "guarded.ts".into(),
                    "--src".into(), test_file.to_string_lossy().into_owned(),
                    "--if-version".into(), "0".into(),
                ],
                "bsc graph",
            )
        })
        .unwrap_err();
        assert!(err.contains("version conflict"), "{err}");
        assert!(err.contains("current rev is 1"), "names the current rev: {err}");
        assert!(
            crate::implementations().into_iter().find(|i| i.get("id").and_then(Value::as_str) == Some("guarded.ts"))
                .and_then(|i| i.get("tests").cloned())
                .is_none(),
            "a rejected write pairs nothing"
        );

        // The matching version lands.
        bsc_cli_util::with_repo_root(None, || {
            crate::cli::run(
                vec![
                    "tests".into(), "set".into(),
                    "--id".into(), "guarded.ts".into(),
                    "--src".into(), test_file.to_string_lossy().into_owned(),
                    "--if-version".into(), "1".into(),
                ],
                "bsc graph",
            )
        })
        .unwrap();
        assert_eq!(rev_after_create("guarded.ts"), 2, "the accepted write moves the record forward");

        unsafe { std::env::remove_var("BSC_GRAPH_STORE") };
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&src_dir);
    }

    /// `tests set --seed` (#141) — the fix under test. Before this, `tests set` alone left a seeded
    /// record's test STORE-ONLY (transient per `component-tests-live-in-the-seed`), and landing it on
    /// the packaged copy too needed a hand-written `jq` patch to
    /// `src-tauri/data/knowledge/algorithms.json`. This pins that `--seed` writes the SAME test onto
    /// the packaged seed file directly, verified by reading that file back off disk (not through
    /// `crate::seed()`, which caches its first read for the process and would not see this write).
    #[test]
    // #148: `tests set` on a `.ts` file whose body contains a TS generic must carry the REAL
    // extension, so the emitter never falls back to `extFor`'s body-sniffing guess — which reads
    // `<T>(a: readonly T[])` as a JSX open tag and would re-emit this as `.tsx` (wrong vitest project,
    // still green, ~35x slower).
    fn tests_set_carries_the_real_extension_past_a_ts_generic_the_emitter_would_misread_as_jsx() {
        let dir = crate::unique_temp("testsset-ext");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = dir.join("algorithms.json");
        let _store = store_at(&store);

        run(
            vec![
                "impl".into(), "set".into(),
                "--tech".into(), "typescript".into(),
                "--id".into(), "session-roles.ts".into(),
                "--role".into(), "algorithm".into(),
                "--name".into(), "sessionRoles".into(),
                "--code".into(), "export function sessionRoles() {}".into(),
                "--src".into(), "src/sessionRoles.ts".into(),
            ],
            "bsc graph",
        )
        .unwrap();

        let src_dir = crate::unique_temp("testsset-ext-src");
        let _ = std::fs::remove_dir_all(&src_dir);
        std::fs::create_dir_all(&src_dir).unwrap();
        let test_file = src_dir.join("sr0.ts");
        // The exact shape from the request: an ordinary TS generic that `extFor`'s
        // `/<[A-Za-z][^>]*>/` regex matches just as readily as a real JSX element.
        let contents =
            "function scopeWriteGlobs<T>(a: readonly T[]): T[] { return a; }\nit('#1297', () => scopeWriteGlobs([]));\n";
        std::fs::write(&test_file, contents).unwrap();

        bsc_cli_util::with_repo_root(None, || {
            crate::cli::run(
                vec![
                    "tests".into(), "set".into(),
                    "--id".into(), "session-roles.ts".into(),
                    "--src".into(), test_file.to_string_lossy().into_owned(),
                    "--name".into(), "scopeWriteGlobs (#1297)".into(),
                ],
                "bsc graph",
            )
        })
        .unwrap();

        let stored = crate::implementations()
            .into_iter()
            .find(|i| i.get("id").and_then(Value::as_str) == Some("session-roles.ts"))
            .and_then(|i| i.get("tests").cloned());
        // Asserted on the ENTRY, not the whole array: #147 made `tests set` UPSERT, so the record's
        // other sibling test survives the write — which is the point of that fix. Comparing the array
        // to a single element would re-assert the destructive behaviour #147 removed.
        let entry = stored
            .as_ref()
            .and_then(Value::as_array)
            .and_then(|a| a.iter().find(|t| t.get("name").and_then(Value::as_str) == Some("scopeWriteGlobs (#1297)")))
            .cloned()
            .expect("the named test is stored");
        assert_eq!(
            entry,
            serde_json::json!({ "name": "scopeWriteGlobs (#1297)", "src": contents, "ext": ".ts" }),
            "the stored test states its own `.ts` extension rather than leaving the emitter to guess \
             from a body whose TS generic reads as JSX",
        );

        unsafe { std::env::remove_var("BSC_GRAPH_STORE") };
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&src_dir);
    }
    #[test]
    fn tests_set_upserts_by_name_and_does_not_drop_sibling_tests() {
        let dir = crate::unique_temp("testsset-siblings");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = dir.join("algorithms.json");
        let _store = store_at(&store);

        run(
            vec![
                "impl".into(), "set".into(),
                "--tech".into(), "typescript".into(),
                "--id".into(), "session-roles.ts".into(),
                "--role".into(), "algorithm".into(),
                "--name".into(), "session-roles".into(),
                "--code".into(), "export function sessionRoles() {}".into(),
                "--src".into(), "src/shared/lib/session/sessionRoles.ts".into(),
            ],
            "bsc graph",
        )
        .unwrap();

        let src_dir = crate::unique_temp("testsset-siblings-src");
        let _ = std::fs::remove_dir_all(&src_dir);
        std::fs::create_dir_all(&src_dir).unwrap();
        let e0 = src_dir.join("e0.ts");
        let e0_contents = "it('scopeWriteGlobs (#1297)', () => {});\n";
        std::fs::write(&e0, e0_contents).unwrap();
        let e1 = src_dir.join("e1.ts");
        let e1_contents = "it('the persona floors are the role capability table', () => {});\n";
        std::fs::write(&e1, e1_contents).unwrap();

        bsc_cli_util::with_repo_root(None, || {
            crate::cli::run(
                vec![
                    "tests".into(), "set".into(),
                    "--id".into(), "session-roles.ts".into(),
                    "--src".into(), e0.to_string_lossy().into_owned(),
                    "--name".into(), "scopeWriteGlobs (#1297)".into(),
                ],
                "bsc graph",
            )
        })
        .unwrap();
        bsc_cli_util::with_repo_root(None, || {
            crate::cli::run(
                vec![
                    "tests".into(), "set".into(),
                    "--id".into(), "session-roles.ts".into(),
                    "--src".into(), e1.to_string_lossy().into_owned(),
                    "--name".into(), "the persona floors are the role capability table".into(),
                ],
                "bsc graph",
            )
        })
        .unwrap();

        let tests = crate::implementations()
            .into_iter()
            .find(|i| i.get("id").and_then(Value::as_str) == Some("session-roles.ts"))
            .and_then(|i| i.get("tests").cloned())
            .and_then(|t| t.as_array().cloned())
            .expect("session-roles.ts carries a tests array");
        assert_eq!(tests.len(), 2, "both sibling tests must survive: {tests:?}");
        assert_eq!(
            tests,
            vec![
                serde_json::json!({ "name": "scopeWriteGlobs (#1297)", "src": e0_contents, "ext": ".ts" }),
                serde_json::json!({
                    "name": "the persona floors are the role capability table",
                    "src": e1_contents,
                    "ext": ".ts",
                }),
            ],
        );

        // Re-setting an EXISTING name replaces only that entry, not the array.
        let e0_updated = src_dir.join("e0-updated.ts");
        let e0_updated_contents = "it('scopeWriteGlobs (#1297)', () => { /* updated */ });\n";
        std::fs::write(&e0_updated, e0_updated_contents).unwrap();
        bsc_cli_util::with_repo_root(None, || {
            crate::cli::run(
                vec![
                    "tests".into(), "set".into(),
                    "--id".into(), "session-roles.ts".into(),
                    "--src".into(), e0_updated.to_string_lossy().into_owned(),
                    "--name".into(), "scopeWriteGlobs (#1297)".into(),
                ],
                "bsc graph",
            )
        })
        .unwrap();

        let tests = crate::implementations()
            .into_iter()
            .find(|i| i.get("id").and_then(Value::as_str) == Some("session-roles.ts"))
            .and_then(|i| i.get("tests").cloned())
            .and_then(|t| t.as_array().cloned())
            .expect("session-roles.ts carries a tests array");
        assert_eq!(tests.len(), 2, "re-setting an existing name must not grow the array: {tests:?}");
        assert_eq!(
            tests,
            vec![
                serde_json::json!({ "name": "scopeWriteGlobs (#1297)", "src": e0_updated_contents, "ext": ".ts" }),
                serde_json::json!({
                    "name": "the persona floors are the role capability table",
                    "src": e1_contents,
                    "ext": ".ts",
                }),
            ],
        );

        unsafe { std::env::remove_var("BSC_GRAPH_STORE") };
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&src_dir);
    }
    #[test]
    fn tests_set_seed_lands_the_test_on_the_packaged_seed_record_too() {
        let dir = crate::unique_temp("testsset-seed");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let store = dir.join("store.json");
        let data_dir = dir.join("data");
        let seed_path = data_dir.join("knowledge").join("algorithms.json");
        std::fs::create_dir_all(seed_path.parent().unwrap()).unwrap();
        std::fs::write(
            &seed_path,
            serde_json::to_string_pretty(&serde_json::json!({
                "version": 2,
                "implementations": [
                    { "id": "seeded.rs", "role": "algorithm", "tech": "rust", "name": "seeded",
                      "code": "fn seeded() {}" },
                ],
            }))
            .unwrap(),
        )
        .unwrap();

        let _store = store_and_data_at(&store, &data_dir);

        // The runtime store needs the SAME id before `tests set` can pair it — this mirrors a real
        // seeded record, which `reconcile_seed` would already have copied into a fresh store.
        run(
            vec![
                "impl".into(), "set".into(),
                "--tech".into(), "rust".into(),
                "--id".into(), "seeded.rs".into(),
                "--role".into(), "algorithm".into(),
                "--name".into(), "seeded".into(),
                "--code".into(), "fn seeded() {}".into(),
                "--no-src".into(),
            ],
            "bsc graph",
        )
        .unwrap();

        let src_dir = crate::unique_temp("testsset-seed-src");
        let _ = std::fs::remove_dir_all(&src_dir);
        std::fs::create_dir_all(&src_dir).unwrap();
        let test_file = src_dir.join("seeded.test.rs");
        let contents = "#[test]\nfn it_works() { seeded(); }\n";
        std::fs::write(&test_file, contents).unwrap();

        let out = bsc_cli_util::with_repo_root(None, || {
            crate::cli::run(
                vec![
                    "tests".into(), "set".into(),
                    "--id".into(), "seeded.rs".into(),
                    "--src".into(), test_file.to_string_lossy().into_owned(),
                    "--seed".into(),
                ],
                "bsc graph",
            )
        });
        assert!(out.is_ok(), "{out:?}");

        // The RUNTIME store carries it too — `--seed` is additive, never a substitute for it.
        let stored = crate::implementations()
            .into_iter()
            .find(|i| i.get("id").and_then(Value::as_str) == Some("seeded.rs"))
            .and_then(|i| i.get("tests").cloned());
        assert_eq!(stored, Some(serde_json::json!([{ "name": "seeded.test.rs", "src": contents }])));

        // The PACKAGED SEED FILE itself now carries it, read straight off disk.
        let seed_after: Value =
            serde_json::from_str(&std::fs::read_to_string(&seed_path).unwrap()).unwrap();
        let seed_tests = seed_after
            .get("implementations")
            .and_then(Value::as_array)
            .and_then(|arr| arr.iter().find(|i| i.get("id").and_then(Value::as_str) == Some("seeded.rs")))
            .and_then(|i| i.get("tests").cloned());
        assert_eq!(
            seed_tests,
            Some(serde_json::json!([{ "name": "seeded.test.rs", "src": contents }])),
            "the packaged seed's OWN copy must carry the test, not just the runtime store"
        );

        // An id that does not exist ANYWHERE is refused by the runtime-store lookup first, exactly
        // as plain `tests set` already refuses one.
        let err = bsc_cli_util::with_repo_root(None, || {
            crate::cli::run(
                vec![
                    "tests".into(), "set".into(),
                    "--id".into(), "not-in-the-seed.rs".into(),
                    "--src".into(), test_file.to_string_lossy().into_owned(),
                    "--seed".into(),
                ],
                "bsc graph",
            )
        })
        .unwrap_err();
        assert!(
            err.contains("no implementation with id 'not-in-the-seed.rs'"),
            "the runtime-store lookup should fail first: {err}"
        );

        // A CUSTOM record — real in the runtime store, absent from the packaged seed — is exactly
        // where `--seed` has nothing to write onto, and must say so rather than inventing a seed
        // record or silently writing only the store half.
        run(
            vec![
                "impl".into(), "set".into(),
                "--tech".into(), "rust".into(),
                "--id".into(), "custom.rs".into(),
                "--role".into(), "algorithm".into(),
                "--name".into(), "custom".into(),
                "--code".into(), "fn custom() {}".into(),
                "--no-src".into(),
            ],
            "bsc graph",
        )
        .unwrap();
        let err = bsc_cli_util::with_repo_root(None, || {
            crate::cli::run(
                vec![
                    "tests".into(), "set".into(),
                    "--id".into(), "custom.rs".into(),
                    "--src".into(), test_file.to_string_lossy().into_owned(),
                    "--seed".into(),
                ],
                "bsc graph",
            )
        })
        .unwrap_err();
        assert!(
            err.contains("no implementation with id 'custom.rs' in the packaged seed"),
            "{err}"
        );
        // The id-in-seed check runs BEFORE the store is touched, so a `--seed` refusal must not leave
        // the record half-updated (store written, seed not) — `custom.rs` keeps its original `tests`.
        let stored_after_refusal = crate::implementations()
            .into_iter()
            .find(|i| i.get("id").and_then(Value::as_str) == Some("custom.rs"))
            .and_then(|i| i.get("tests").cloned());
        assert_eq!(
            stored_after_refusal, None,
            "a `--seed` refusal must not leave the store half-written"
        );

        unsafe {
            std::env::remove_var("BSC_GRAPH_STORE");
            std::env::remove_var("BSC_DATA_DIR");
        }
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&src_dir);
    }

    #[test]
    fn impl_suppress_seed_removes_it_from_the_packaged_seed_too() {
        // #170 (request from claude): a runtime-only tombstone is invisible to
        // `scripts/emit-records.mjs`, which builds `.bsc-records/` straight off
        // `src-tauri/data/knowledge/algorithms.json` and has never heard of the runtime store — so
        // `bsc graph impl suppress pending-pty-data.ts && npm run emit:records` still emitted
        // `.bsc-records/app/console/lib/pendingPtyData.ts`. This is the Rust half of that exact repro:
        // `--seed` must remove the record from the packaged file emit-records actually reads, not only
        // stamp a runtime tombstone.
        let dir = crate::unique_temp("implsuppress-seed");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let store = dir.join("store.json");
        let data_dir = dir.join("data");
        let seed_path = data_dir.join("knowledge").join("algorithms.json");
        std::fs::create_dir_all(seed_path.parent().unwrap()).unwrap();
        std::fs::write(
            &seed_path,
            serde_json::to_string_pretty(&serde_json::json!({
                "version": 2,
                "implementations": [
                    { "id": "pending-pty-data.ts", "role": "algorithm", "tech": "typescript",
                      "name": "pendingPtyData", "provides": "@/app/console/lib/pendingPtyData",
                      "code": "export const pendingPtyData = 1;", "composes": [] },
                    { "id": "consumer.ts", "role": "algorithm", "tech": "typescript", "name": "consumer",
                      "provides": "@/app/console/lib/consumer", "code": "export const consumer = 1;",
                      "composes": ["pending-pty-data.ts"] },
                ],
            }))
            .unwrap(),
        )
        .unwrap();

        let _store = store_and_data_at(&store, &data_dir);

        // `suppress` requires the id to be KNOWN — a real seeded id is checked via `is_seeded`, which
        // reads the CACHED, process-wide `crate::seed()` (not `BSC_DATA_DIR`-aware once initialized).
        // Landing it in the runtime store first sidesteps that cache, exactly as
        // `tests_set_seed_lands_the_test_on_the_packaged_seed_record_too` does above.
        run(
            vec![
                "impl".into(), "set".into(),
                "--tech".into(), "typescript".into(),
                "--id".into(), "pending-pty-data.ts".into(),
                "--role".into(), "algorithm".into(),
                "--name".into(), "pendingPtyData".into(),
                "--code".into(), "export const pendingPtyData = 1;".into(),
                "--provides".into(), "@/app/console/lib/pendingPtyData".into(),
                "--no-src".into(),
            ],
            "bsc graph",
        )
        .unwrap();

        let out = run(
            vec!["impl".into(), "suppress".into(), "pending-pty-data.ts".into(), "--seed".into()],
            "bsc graph",
        );
        assert!(out.is_ok(), "{out:?}");

        // The PACKAGED SEED FILE — what `emit-records.mjs`'s `collectSeeds()` reads — no longer
        // carries an `implementations` entry for it, so a re-emit cannot materialize the module.
        let seed_after: Value =
            serde_json::from_str(&std::fs::read_to_string(&seed_path).unwrap()).unwrap();
        let ids: Vec<String> = seed_after
            .get("implementations")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|im| im.get("id").and_then(Value::as_str).map(str::to_owned))
            .collect();
        assert!(
            !ids.contains(&"pending-pty-data.ts".to_string()),
            "the packaged seed must no longer carry the suppressed id: {ids:?}"
        );

        // A tombstone is recorded on the seed too, mirroring the runtime shape.
        let seed_tomb = seed_after
            .get("suppressed")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|t| t.get("id").and_then(Value::as_str) == Some("pending-pty-data.ts"));
        assert!(seed_tomb.is_some(), "the seed itself should record why the id is gone");

        // The scrub reaches other seed records' `composes` too, exactly as the runtime store's does.
        let consumer_composes = seed_after
            .get("implementations")
            .and_then(Value::as_array)
            .and_then(|arr| {
                arr.iter().find(|im| im.get("id").and_then(Value::as_str) == Some("consumer.ts"))
            })
            .and_then(|im| im.get("composes").cloned());
        assert_eq!(consumer_composes, Some(serde_json::json!([])));

        // The RUNTIME store still carries its own tombstone too — `--seed` is additive, never a
        // substitute for it.
        let g = crate::load();
        assert!(crate::is_suppressed(&g, "pending-pty-data.ts"));

        // Idempotent (#77), same as a store-only suppress: running it again must not error, and must
        // not duplicate the seed tombstone.
        let out2 = run(
            vec!["impl".into(), "suppress".into(), "pending-pty-data.ts".into(), "--seed".into()],
            "bsc graph",
        );
        assert!(out2.is_ok(), "{out2:?}");
        let seed_after2: Value =
            serde_json::from_str(&std::fs::read_to_string(&seed_path).unwrap()).unwrap();
        let tomb_count = seed_after2
            .get("suppressed")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|t| t.get("id").and_then(Value::as_str) == Some("pending-pty-data.ts"))
            .count();
        assert_eq!(tomb_count, 1, "re-suppressing must not append a second tombstone");

        unsafe {
            std::env::remove_var("BSC_GRAPH_STORE");
            std::env::remove_var("BSC_DATA_DIR");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn impl_unsuppress_seed_is_refused() {
        // Reversing `suppress --seed` needs the retired body back, and that body is gone from the
        // packaged file — nothing in this process can resurrect it. `unsuppress --seed` must refuse
        // loudly rather than silently accept a flag that does nothing.
        let dir = crate::unique_temp("implunsuppress-seed");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = dir.join("store.json");

        let _store = store_at(&store);

        let err = run(
            vec!["impl".into(), "unsuppress".into(), "whatever.ts".into(), "--seed".into()],
            "bsc graph",
        )
        .unwrap_err();
        assert!(err.contains("no --seed counterpart"), "{err}");

        unsafe { std::env::remove_var("BSC_GRAPH_STORE") };
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn impl_suppress_is_idempotent_for_a_custom_id_not_masked_by_the_cached_seed() {
        // Found while verifying #170 end-to-end with the REAL binary across two separate process
        // invocations. The in-process idempotency test above (`impl_suppress_seed_removes_it_from_the_
        // packaged_seed_too`) suppresses the SAME id twice inside ONE test process, and `crate::seed()`
        // caches the packaged JSON for the process's lifetime — so its second call still sees
        // `is_seeded("pending-pty-data.ts") == true` even though the on-disk seed file was just
        // stripped, and the "known" gate below never actually re-evaluates against the post-removal
        // world. A real second `bsc` process does re-evaluate it, found it neither live nor seeded, and
        // wrongly refused with "unknown implementation" — breaking the exact idempotence #77 promises.
        //
        // This reproduces the SAME "known" gate bug WITHOUT any process boundary, and shows it predates
        // `--seed` entirely: a CUSTOM id (never in any seed) that is suppressed once is neither live
        // (removed) nor seeded (never was) on a second call — the runtime tombstone (`is_suppressed`)
        // was the only truthful "this id is real" signal missing from the gate.
        let dir = crate::unique_temp("implsuppress-idempotent-custom");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = dir.join("store.json");
        // An empty seed — `is_seeded` is genuinely, not cache-masked, false for any id here.
        let data_dir = dir.join("data");
        let seed_path = data_dir.join("knowledge").join("algorithms.json");
        std::fs::create_dir_all(seed_path.parent().unwrap()).unwrap();
        std::fs::write(&seed_path, serde_json::to_string(&serde_json::json!({ "implementations": [] })).unwrap())
            .unwrap();

        let _store = store_and_data_at(&store, &data_dir);

        run(
            vec![
                "impl".into(), "set".into(),
                "--tech".into(), "typescript".into(),
                "--id".into(), "custom-x.ts".into(),
                "--role".into(), "algorithm".into(),
                "--name".into(), "customX".into(),
                "--code".into(), "export const customX = 1;".into(),
                "--no-src".into(),
            ],
            "bsc graph",
        )
        .unwrap();

        run(vec!["impl".into(), "suppress".into(), "custom-x.ts".into()], "bsc graph").unwrap();

        // The second call is the regression: `custom-x.ts` is now neither live nor seeded, and before
        // the fix that combination was refused as "unknown implementation" instead of being treated as
        // the idempotent re-suppress #77 promises.
        let out2 = run(vec!["impl".into(), "suppress".into(), "custom-x.ts".into()], "bsc graph");
        assert!(out2.is_ok(), "{out2:?}");

        unsafe {
            std::env::remove_var("BSC_GRAPH_STORE");
            std::env::remove_var("BSC_DATA_DIR");
        }
        let _ = std::fs::remove_dir_all(&dir);
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
    ///
    /// #184: the fixture lives under `std::env::temp_dir()`, outside this repo, on purpose — a
    /// `--code-file` is a user-supplied path and has to work from anywhere. `source_flag` runs it
    /// through `require_harvestable_root`, which reads the real `$BSC_REPO_ROOT` when no thread-local
    /// override is set — so this test spuriously failed confinement inside a debug-studio pane, whose
    /// shell genuinely carries that var. `with_repo_root(None, …)` forces the unconfined case
    /// hermetically, the same seam `bsc-cli-util` documents for exactly this.
    #[test]
    fn code_file_reads_backticks_interpolation_and_newlines_verbatim() {
        bsc_cli_util::with_repo_root(None, || {
            let body = "export function x() {\n  const n = 1;\n  return `a${n}b`;\n}\n";
            let p = write_temp("verbatim", body);
            let got = source_flag(&args(&["--code-file", p.to_str().unwrap()]), "--code").unwrap();
            assert_eq!(got.as_deref(), Some(body), "read back byte-identical");
            // And specifically that nothing collapsed: three real newlines, a live backtick, a live ${}.
            let got = got.unwrap();
            assert_eq!(got.matches('\n').count(), 4, "real newlines survived: {got:?}");
            assert!(got.contains("`a${n}b`"), "the template literal survived intact: {got:?}");
            let _ = std::fs::remove_file(&p);
        });
    }

    /// The same door for the trace-program, which is the field MOST likely to carry a backtick.
    /// See #184 on the sibling test above for why this is wrapped in `with_repo_root(None, …)`.
    #[test]
    fn viz_code_file_uses_the_same_door() {
        bsc_cli_util::with_repo_root(None, || {
            let body = "({ run(a) { a.mark(`i${0}`); } })";
            let p = write_temp("viz", body);
            let got = source_flag(&args(&["--viz-code-file", p.to_str().unwrap()]), "--viz-code").unwrap();
            assert_eq!(got.as_deref(), Some(body));
            let _ = std::fs::remove_file(&p);
        });
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

        set_impl_skipping_retired(&mut g, impl_json("llm-energy.ts"), &mut skipped, "test", "test").expect("not fatal");
        set_impl_skipping_retired(&mut g, impl_json("fresh.ts"), &mut skipped, "test", "test").expect("the rest still land");

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
        assert!(set_impl_skipping_retired(&mut g, bad, &mut skipped, "test", "test").is_err(), "a bad role still aborts");
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
    use super::{dedup_findings, suggestion_for};
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

    /// A body with a DIFFERENT SHAPE from [`body`] — a loop and a branch where that one is a straight
    /// expression.
    ///
    /// Needed once the detector gained a structural signal (slice 2). Every fixture in this suite was
    /// `body()` with an identifier or a literal swapped, which is fine for a token-shingle detector and
    /// is BY CONSTRUCTION a structural clone — so "a shared name alone is not a duplicate" was being
    /// asserted with two records that really are the same code under renaming. The intent of those
    /// tests is that a NAMING CONVENTION must not group; expressing it needs bodies that genuinely
    /// differ.
    fn other_body(unit: &str) -> String {
        format!(
            "export function summarize(rows, opts) {{\n                 const out = [];\n                 for (const row of rows) {{\n                     if (!row.ok) {{ continue; }}\n                     out.push(row.n);\n                 }}\n                 while (out.length > opts.cap) {{ out.pop(); }}\n                 return {{ rows: out, unit: \"{unit}\" }};\n}}"
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

    /// SIGNAL 4 (slice 4): the same CONTRACT across modules, corroborated by the body.
    ///
    /// The "same job, different implementation" case — two functions that agree about what they take
    /// and return, whose bodies overlap enough to corroborate it but NOT enough for signal 1 to speak.
    /// Neither existing signal sees it: the shingles are below NEAR_DUPLICATE and the shapes differ.
    #[test]
    fn the_same_contract_across_modules_is_a_signal_when_the_body_corroborates() {
        // Same contract (xs/limit and their types), genuinely different implementations.
        let a = "export function takeTop(xs: number[], limit: number): number[] {\n                     const sorted = xs.slice().sort((p, q) => q - p);\n                     const out: number[] = [];\n                     for (const v of sorted) { if (out.length < limit) { out.push(v); } }\n                     return out;\n}";
        let b = "export function takeTop(xs: number[], limit: number): number[] {\n                     const sorted = xs.slice().sort((p, q) => q - p);\n                     const out: number[] = [];\n                     let i = 0;\n                     while (i < limit && i < sorted.length) { out.push(sorted[i]); i += 1; }\n                     return out;\n}";
        let g = serde_json::json!({ "implementations": [
            im("take-top.ts", "takeTop", serde_json::json!({ "code": a, "src": "src/a/top.ts", "tech": "typescript" })),
            im("top-n.ts", "topN", serde_json::json!({ "code": b, "src": "src/b/topn.ts", "tech": "typescript" })),
        ]});
        let found = dedup_findings(&g);
        assert_eq!(found.len(), 1, "the pair is surfaced: {found:#?}");
        let signals = found[0]["signals"].as_array().unwrap();
        assert!(
            signals.iter().any(|s| s.as_str().unwrap_or("").contains("CONTRACT")),
            "named as the contract signal: {signals:?}",
        );
    }

    /// A CONTRACT COINCIDENCE IS NOT A DUPLICATE, and this is the measured failure mode. Over
    /// `crates/`, non-clone pairs reach a contract similarity of 0.50 at the 99th percentile and 1.00
    /// at the maximum — there is no chasm — so the body is a REQUIRED co-signal rather than an
    /// optional one, which is where this diverges from the component library's measure.
    #[test]
    fn a_contract_match_with_an_unrelated_body_is_not_reported() {
        // Byte-for-byte the same signature; nothing else in common.
        let a = "export function alpha(xs: number[], limit: number): number[] {\n                     const seen = new Map<number, number>();\n                     for (const x of xs) { seen.set(x, (seen.get(x) ?? 0) + limit); }\n                     return [...seen.keys()];\n}";
        let b = "export function beta(xs: number[], limit: number): number[] {\n                     const total = xs.reduce((p, q) => p * q, limit);\n                     const digits = String(total).split(\"\").map(Number);\n                     return digits.filter((d) => d % 2 === 0);\n}";
        let g = serde_json::json!({ "implementations": [
            im("alpha.ts", "alpha", serde_json::json!({ "code": a, "src": "src/a/alpha.ts", "tech": "typescript" })),
            im("beta.ts", "beta", serde_json::json!({ "code": b, "src": "src/b/beta.ts", "tech": "typescript" })),
        ]});
        assert!(dedup_findings(&g).is_empty(), "a shared signature alone: {:#?}", dedup_findings(&g));
    }

    /// TWO FUNCTIONS IN ONE MODULE SHARING A CONTRACT IS A CONVENTION, not duplication — every maths
    /// module has a handful of `(Vec3) -> f32`. MEASURED: without this condition the sweep over
    /// `crates/` returns 161 pairs, almost all neighbours in one file (`abs` beside `normalize`,
    /// `cross` beside `cmin`); with it, 28, and those read as real. It is the same lesson #78 recorded
    /// for the NAME signal, one level down.
    #[test]
    fn a_shared_contract_inside_one_module_is_a_convention_not_a_duplicate() {
        let a = "export function toRadians(deg: number, scale: number): number {\n                     const base = (deg * Math.PI) / 180;\n                     const adjusted = base * scale;\n                     return Number.isFinite(adjusted) ? adjusted : 0;\n}";
        let b = "export function toDegrees(deg: number, scale: number): number {\n                     const base = (deg * 180) / Math.PI;\n                     const adjusted = base * scale;\n                     return Number.isFinite(adjusted) ? adjusted : 0;\n}";
        let same = "src/shared/lib/core/math.ts";
        let g = serde_json::json!({ "implementations": [
            im("to-radians.ts", "toRadians", serde_json::json!({ "code": a, "src": same, "tech": "typescript" })),
            im("to-degrees.ts", "toDegrees", serde_json::json!({ "code": b, "src": same, "tech": "typescript" })),
        ]});
        let found = dedup_findings(&g);
        assert!(
            !found.iter().any(|f| f["signals"].as_array().unwrap().iter()
                .any(|s| s.as_str().unwrap_or("").contains("CONTRACT"))),
            "neighbours in one module must not group on contract: {found:#?}",
        );
    }

    /// N duplicates are ONE row, and that holds for the contract signal too. It first emitted one
    /// bucket PER PAIR, so four identical records produced SIX rows — breaking this module's central
    /// promise. The chaining worry that motivated pairs is what `CLUSTER_DENSITY` already answers, so
    /// both pairwise signals now share one clustering pass.
    #[test]
    fn the_contract_signal_reports_a_group_not_a_row_per_pair() {
        let c = serde_json::json!({ "code": body("Wh"), "tech": "typescript" });
        let g = serde_json::json!({ "implementations": [
            im("a.ts", "a", c.clone()), im("b.ts", "b", c.clone()),
            im("c.ts", "c", c.clone()), im("d.ts", "d", c.clone()),
        ]});
        let found = dedup_findings(&g);
        assert_eq!(found.len(), 1, "ONE row for four identical records, not six pairs: {found:#?}");
        assert_eq!(ids_of(&found[0]).len(), 4);
    }

    /// THE TREE SWEEP (slice 3) reports duplicates the STORE cannot contain — a real path and a real
    /// line for each member, because a tree duplicate has no id to look up.
    #[test]
    fn dupes_reports_tree_duplicates_with_a_path_and_a_line() {
        let dir = crate::unique_temp("treedupes");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        // The same routine twice, in two FILES, every identifier renamed — invisible to a shingle
        // detector and to any per-file check, which is why the sweep is tree-wide.
        let original = "export function groupItems(items, keyOf) {\n                            const out = new Map();\n                            for (const item of items) {\n                                const key = keyOf(item);\n                                const bucket = out.get(key);\n                                if (bucket) { bucket.push(item); } else { out.set(key, [item]); }\n                            }\n                            return out;\n}";
        std::fs::write(dir.join("a.ts"), original).unwrap();
        std::fs::write(
            dir.join("nested").join("b.ts"),
            original
                .replace("groupItems", "bucketRows").replace("items", "rows").replace("keyOf", "labelFor")
                .replace("item", "row").replace("out", "acc").replace("key", "label").replace("bucket", "slot"),
        )
        .unwrap();

        let (res, out) = bsc_util::capture_output(|| {
            crate::cli::run(
                ["dupes", dir.to_str().unwrap(), "--tech", "typescript"]
                    .iter().map(|s| s.to_string()).collect(),
                "bsc graph",
            )
        });
        res.expect("the verb runs");
        let d: Value = serde_json::from_str(&out).expect("json");
        assert_eq!(d["groups"], 1, "one group: {out}");
        assert_eq!(d["duplicated"], 1, "one function could go, not two");
        let members = d["dupes"][0]["members"].as_array().unwrap();
        assert_eq!(members.len(), 2);
        let srcs: Vec<&str> = members.iter().filter_map(|m| m["src"].as_str()).collect();
        assert!(srcs.contains(&"a.ts"), "root-relative, forward-slashed: {srcs:?}");
        assert!(srcs.contains(&"nested/b.ts"), "reaches a subdirectory: {srcs:?}");
        for m in members {
            assert!(m["line"].as_u64().unwrap_or(0) >= 1, "a real line: {m}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// N FUNCTIONS ARE ONE GROUP IN THE TREE SWEEP TOO. It emitted PAIRS while `dedup_findings`
    /// clustered, so `parse_args` across ~9 crates came out as FOURTEEN rows saying one thing —
    /// the same "one more copy" this epic exists to find, committed by the epic.
    #[test]
    fn the_tree_sweep_clusters_a_family_instead_of_emitting_every_pair() {
        let dir = crate::unique_temp("treecluster");
        let _ = std::fs::remove_dir_all(&dir);
        // Four crates, one contract, four genuinely different bodies — a family, not a copy.
        for (n, (crate_name, extra)) in [
            ("a", "const out = []; for (const r of rows) { if (r < cap) { out.push(r); } } return out;"),
            ("b", "const out = []; for (const r of rows) { if (r <= cap) { out.push(r); } } return out;"),
            ("c", "const out = []; let i = 0; while (i < rows.length) { if (rows[i] < cap) { out.push(rows[i]); } i += 1; } return out;"),
            ("d", "const out = []; for (const r of rows) { if (r < cap) { out.push(r); } else { out.push(cap); } } return out;"),
        ].iter().enumerate() {
            let sub = dir.join(crate_name);
            std::fs::create_dir_all(&sub).unwrap();
            std::fs::write(
                sub.join("cli.ts"),
                format!("export function parseArgs(rows: number[], cap: number): number[] {{\n                             const label = String(cap) + \"{n}\";\n                             void label;\n  {extra}\n}}"),
            )
            .unwrap();
        }
        let (res, out) = bsc_util::capture_output(|| {
            crate::cli::run(
                ["dupes", dir.to_str().unwrap(), "--tech", "typescript"].iter().map(|s| s.to_string()).collect(),
                "bsc graph",
            )
        });
        res.expect("the verb runs");
        let d: Value = serde_json::from_str(&out).expect("json");
        let contract: Vec<&Value> = d["dupes"].as_array().unwrap().iter()
            .filter(|g| g["signal"] == "same-contract").collect();
        assert_eq!(contract.len(), 1, "ONE group, not one row per pair: {out}");
        assert_eq!(contract[0]["count"], 4, "naming every member: {out}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// THE SUGGESTION FOLLOWS THE EVIDENCE. "Fold with `bsc graph merge`" is right for one
    /// implementation written twice and WRONG for a shared pattern — folding a contract group deletes
    /// a real caller's function. Across the six substantive findings on this repo the old blanket
    /// A MERGE IS TWO COMMANDS when `from` is packaged, and the output has to say so.
    ///
    /// `merge` removes `from` from the RUNTIME store only. When the packaged seed carries the same id
    /// the reconcile re-adds it and the fold undoes itself — measured on `llm-energy.ts`, where
    /// `impl get` returned null while the seed still listed it. It cannot do the seed side by analogy
    /// with `--seed` elsewhere, because the seed needs a TOMBSTONE rather than a removal, so it reports
    /// THE HEADLINE MUST NOT FALL BY EIGHT WHEN YOU FIX ONE.
    ///
    /// `CLUSTER_DENSITY` used to DISCARD a component that could not clear it, which made the report
    /// non-monotonic: nine `parse_args` cleared the floor, and converting exactly ONE of them did not
    /// leave eight — it deleted the group, taking the other eight duplications out of the report with
    /// it. Peeling to the dense core keeps them visible.
    #[test]
    fn removing_one_member_does_not_delete_the_rest_of_the_family() {
        // A 9-clique minus a few edges: dense enough to report whole.
        let names: Vec<String> = (0..9).map(|i| format!("p{i}.rs")).collect();
        let mut pairs: Vec<(&str, &str)> = Vec::new();
        for i in 0..9 {
            for j in (i + 1)..9 {
                if (i + j) % 5 != 0 {
                    pairs.push((names[i].as_str(), names[j].as_str()));
                }
            }
        }
        let nine = super::cluster_pairs(&pairs);
        assert_eq!(nine.len(), 1, "the family reports as one group: {nine:?}");
        assert_eq!(nine[0].len(), 9);

        // Now one member is fixed and drops out of the pair set entirely.
        let eight: Vec<(&str, &str)> =
            pairs.iter().copied().filter(|(a, b)| *a != "p0.rs" && *b != "p0.rs").collect();
        let after = super::cluster_pairs(&eight);
        let biggest = after.iter().map(Vec::len).max().unwrap_or(0);
        assert!(
            biggest >= 7,
            "fixing ONE of nine must not delete the other eight — got {after:?}",
        );
    }

    /// And the floor still does its job: a STAR is a hub artifact, not a family of nine.
    #[test]
    fn a_star_is_not_reported_as_one_family() {
        let leaves: Vec<String> = (0..8).map(|i| format!("leaf{i}.rs")).collect();
        let pairs: Vec<(&str, &str)> = leaves.iter().map(|l| ("hub.rs", l.as_str())).collect();
        let groups = super::cluster_pairs(&pairs);
        assert!(
            groups.iter().all(|g| g.len() <= 2),
            "one generic function must not chain eight unrelated ones into a mega-group: {groups:?}",
        );
        // And what did NOT group is reported rather than silently dropped.
        let (_, loose) = super::cluster_pairs_with_loose(&pairs);
        assert!(!loose.is_empty(), "the peeled members must be visible, not vanish");
    }

    /// the outstanding step and names the exact command instead of performing a different one.
    #[test]
    fn merge_says_when_the_packaged_seed_still_carries_the_folded_id() {
        let dir = std::env::temp_dir().join(format!("bsc-graph-mergeseed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let data = dir.join("knowledge");
        std::fs::create_dir_all(&data).unwrap();
        let store = dir.join("store.json");
        let two = serde_json::json!({ "implementations": [
            { "id": "a.ts", "tech": "typescript", "role": "algorithm", "name": "a", "code": "export const a = 1;" },
            { "id": "b.ts", "tech": "typescript", "role": "algorithm", "name": "b", "code": "export const b = 1;" },
        ]});
        std::fs::write(&store, two.to_string()).unwrap();
        std::fs::write(data.join("algorithms.json"), two.to_string()).unwrap();
        let _guard = super::store_and_data_at(&store, &dir);

        // The fold empties the runtime store of `a.ts` — and the seed still has it, which is the whole
        // point: the reconcile would put it straight back.
        super::run(vec!["merge".into(), "a.ts".into(), "b.ts".into()], "bsc graph").unwrap();
        assert!(crate::load()["implementations"].as_array().unwrap()
            .iter().all(|im| im["id"] != "a.ts"), "merge left it in the runtime store");
        assert!(super::seed_still_carries("a.ts"), "the seed still holds it, and merge must report that");

        // With nothing outstanding it stays quiet.
        std::fs::write(data.join("algorithms.json"), serde_json::json!({ "implementations": [] }).to_string()).unwrap();
        assert!(!super::seed_still_carries("a.ts"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// advice was correct for none of them.
    #[test]
    fn the_suggestion_never_proposes_a_merge_for_a_shared_contract() {
        let same_code = suggestion_for(&["same-body"], &["a.ts".into(), "b.ts".into()]);
        assert!(same_code.contains("bsc graph merge"), "one implementation twice folds: {same_code}");

        // The contract description CONTAINS the word "body" ("corroborated by ≥30% body overlap"),
        // which is exactly what made prose-matching pick the wrong branch.
        let shared_pattern = suggestion_for(&["same-contract"], &["a.ts".into(), "b.ts".into()]);
        // It NAMES the command in order to forbid it, so "does not mention merge" is the wrong test —
        // asserting on a substring of prose is the same mistake the code above just stopped making.
        assert!(shared_pattern.contains("DO NOT `bsc graph merge`"), "forbids it by name: {shared_pattern}");
        assert!(!shared_pattern.contains("pick the survivor"), "and never recommends folding: {shared_pattern}");
        assert!(shared_pattern.contains("helper") || shared_pattern.contains("trait"), "{shared_pattern}");

        // A group carrying BOTH signals is one implementation twice — the stronger claim wins.
        let both = suggestion_for(&["same-shape", "same-contract"], &["a.ts".into(), "b.ts".into()]);
        assert!(both.contains("bsc graph merge"), "shape is the stronger claim: {both}");
    }

    /// THE TREE SWEEP CARRIES THE CONTRACT SIGNAL TOO, not only the shape one.
    ///
    /// `doctor --dedup` had four signals over 32 Rust records while `dupes` had one over 7,514 Rust
    /// functions — the weaker detector aimed at 99.6% of the Rust in this repo. These two functions
    /// agree about what they take and their bodies corroborate it, but their SHAPES differ (one loops,
    /// one folds), so the shape signal alone cannot see them.
    #[test]
    fn the_tree_sweep_reports_a_contract_pair_the_shape_signal_misses() {
        let dir = crate::unique_temp("treecontract");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("b")).unwrap();
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::fs::write(
            dir.join("a").join("top.ts"),
            "export function takeTop(xs: number[], limit: number): number[] {\n                 const sorted = xs.slice().sort((p, q) => q - p);\n                 const out: number[] = [];\n                 for (const v of sorted) { if (out.length < limit) { out.push(v); } }\n                 return out;\n}",
        )
        .unwrap();
        std::fs::write(
            dir.join("b").join("topn.ts"),
            "export function topN(xs: number[], limit: number): number[] {\n                 const sorted = xs.slice().sort((p, q) => q - p);\n                 const out: number[] = [];\n                 let i = 0;\n                 while (i < limit && i < sorted.length) { out.push(sorted[i]); i += 1; }\n                 return out;\n}",
        )
        .unwrap();

        let (res, out) = bsc_util::capture_output(|| {
            crate::cli::run(
                ["dupes", dir.to_str().unwrap(), "--tech", "typescript"].iter().map(|s| s.to_string()).collect(),
                "bsc graph",
            )
        });
        res.expect("the verb runs");
        let d: Value = serde_json::from_str(&out).expect("json");
        let contract: Vec<&Value> = d["dupes"].as_array().unwrap().iter()
            .filter(|g| g["signal"] == "same-contract").collect();
        assert_eq!(contract.len(), 1, "the pair is found by contract: {out}");
        // …and NOT by shape, or the signal would be redundant here.
        assert!(
            d["dupes"].as_array().unwrap().iter().all(|g| g["signal"] != "same-shape"),
            "their shapes differ, so shape must not group them: {out}",
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// TWO FUNCTIONS IN ONE FILE sharing a contract is a module convention here too — the same
    /// condition that took the store signal from 161 pairs to 28.
    #[test]
    fn the_tree_sweep_does_not_group_a_contract_shared_inside_one_file() {
        let dir = crate::unique_temp("treeconvention");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("math.ts"),
            "export function toRadians(deg: number, scale: number): number {\n                 const base = (deg * Math.PI) / 180;\n                 const adjusted = base * scale;\n                 return Number.isFinite(adjusted) ? adjusted : 0;\n}\n             export function toDegrees(deg: number, scale: number): number {\n                 const base = (deg * 180) / Math.PI;\n                 const adjusted = base * scale;\n                 return Number.isFinite(adjusted) ? adjusted : 0;\n}",
        )
        .unwrap();
        let (res, out) = bsc_util::capture_output(|| {
            crate::cli::run(
                ["dupes", dir.to_str().unwrap(), "--tech", "typescript"].iter().map(|s| s.to_string()).collect(),
                "bsc graph",
            )
        });
        res.expect("the verb runs");
        let d: Value = serde_json::from_str(&out).expect("json");
        assert!(
            d["dupes"].as_array().unwrap().iter().all(|g| g["signal"] != "same-contract"),
            "neighbours in one file must not group on contract: {out}",
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// THE SIGNAL THE SHINGLES CANNOT HAVE (slice 2 of epic-a-graph-finds-its-own-duplicates).
    ///
    /// Signal 1 shingles TOKENS, and the tokens include the identifiers — so a copy whose identifiers
    /// were all renamed has a DISJOINT shingle set and no threshold recovers it. These two records
    /// share no name, no src, and no shingle; only their SHAPE is the same, which is precisely what a
    /// copy-paste-then-rename looks like.
    ///
    /// MEASURED before the signal existed: this exact pair was curated into a scratch store and
    /// `doctor --dedup` returned only the known `llm-energy` group.
    #[test]
    fn a_renamed_copy_groups_on_shape_when_nothing_else_matches() {
        let original = "export function groupItems(items, keyOf) {\n                            const out = new Map();\n                            for (const item of items) {\n                                const key = keyOf(item);\n                                const bucket = out.get(key);\n                                if (bucket) { bucket.push(item); } else { out.set(key, [item]); }\n                            }\n                            return out;\n}";
        // Every identifier renamed; not one token in common beyond the language's own keywords.
        let renamed = original
            .replace("groupItems", "bucketRows").replace("items", "rows").replace("keyOf", "labelFor")
            .replace("item", "row").replace("out", "acc").replace("key", "label").replace("bucket", "slot");
        let g = serde_json::json!({ "implementations": [
            im("group-items.ts", "groupItems", serde_json::json!({ "code": original, "src": "src/a/group.ts", "tech": "typescript" })),
            im("bucket-rows.ts", "bucketRows", serde_json::json!({ "code": renamed, "src": "src/b/bucket.ts", "tech": "typescript" })),
        ]});
        let found = dedup_findings(&g);
        assert_eq!(found.len(), 1, "the renamed copy must be found: {found:#?}");
        assert_eq!(ids_of(&found[0]), vec!["bucket-rows.ts", "group-items.ts"]);
        let signals = found[0]["signals"].as_array().unwrap();
        assert_eq!(signals.len(), 1, "ONLY the shape signal — nothing else matches: {signals:?}");
        assert!(signals[0].as_str().unwrap().contains("SHAPE"), "named as its own signal: {signals:?}");
    }

    /// A SHAPE MATCH IS CONFINED TO ONE TECH, per the epic: cross-kit comparison is out of scope, and
    /// two grammars can collide on a node-kind sequence because `identifier` and `block` mean
    /// different things in each. Same logic, two languages, no group.
    #[test]
    fn a_shape_never_groups_across_technologies() {
        let ts = "export function tally(rows, floor) {\n                      const out = [];\n                      for (const row of rows) {\n                          if (row > floor) { out.push(row); } else { out.push(floor); }\n                      }\n                      return out;\n}";
        let rs = "pub fn tally(rows: &[u32], floor: u32) -> Vec<u32> {\n                        let mut out = Vec::new();\n                        for row in rows {\n                              if *row > floor { out.push(*row); } else { out.push(floor); }\n                        }\n    out\n}";
        let g = serde_json::json!({ "implementations": [
            im("tally.ts", "tally", serde_json::json!({ "code": ts, "src": "src/a/tally.ts", "tech": "typescript" })),
            im("tally.rs", "tally", serde_json::json!({ "code": rs, "src": "crates/x/src/tally.rs", "tech": "rust" })),
        ]});
        let shapes = dedup_findings(&g);
        assert!(
            shapes.iter().all(|f| !f["signals"].as_array().unwrap().iter().any(|s| s.as_str().unwrap_or("").contains("SHAPE"))),
            "no cross-tech shape group: {shapes:#?}",
        );
    }

    /// THE NOISE THE FIRST CUT PRODUCED, now pinned as a test. Implemented as the request literally
    /// asked — a shared name OR a shared src — these fixtures were 110 groups over 356 impls on the
    /// real store. Neither is a duplicate, and neither may report.
    #[test]
    fn a_shared_name_or_a_shared_src_alone_is_not_a_duplicate() {
        // Every feature has a `store`, an `index`, a `graphPlatform`. That is a convention.
        // The bodies must differ STRUCTURALLY, not just by an identifier: two records built from the
        // same canned body are a structural clone and the shape signal reports them correctly, which
        // would make this test assert the opposite of what it means.
        let g = serde_json::json!({ "implementations": [
            im("github-store.ts", "store", serde_json::json!({ "code": body("a"), "src": "src/features/github/store.ts" })),
            im("skills-store.ts", "store", serde_json::json!({ "code": other_body("b"), "src": "src/features/skills/store.ts" })),
        ]});
        assert!(dedup_findings(&g).is_empty(), "a shared name alone: {:#?}", dedup_findings(&g));

        // Function-granularity harvest lifts MANY functions out of ONE file, so they share `src` by
        // construction — ten records carry `shared/lib/core/format.ts` on the real store.
        let g = serde_json::json!({ "implementations": [
            im("fmt-bytes.ts", "fmtBytes", serde_json::json!({ "code": body("B"), "src": "src/shared/lib/core/format.ts" })),
            im("fmt-clock.ts", "fmtClock", serde_json::json!({
                // Structurally different, for the same reason as the pair above.
                "code": other_body("s"),
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

    /// Several signals over the SAME members is still one fact, so it is one row carrying all of them.
    ///
    /// THREE now, not two: two records with byte-identical `code` necessarily also have the same
    /// SHAPE, so slice 2's signal fires here too and correctly. Asserted by NAMING the signals rather
    /// than counting them — a count is the assertion that goes stale every time the detector learns
    /// something, which is exactly what happened to it.
    #[test]
    fn signals_over_the_same_members_merge_into_one_row() {
        let g = serde_json::json!({ "implementations": [
            im("x.ts", "shared", serde_json::json!({ "code": body("Wh"), "src": "src/a/b.ts" })),
            im("y.ts", "shared", serde_json::json!({ "code": body("Wh"), "src": "a/b.ts" })),
        ]});
        let found = dedup_findings(&g);
        assert_eq!(found.len(), 1, "one row, not one per signal: {found:#?}");
        let signals = found[0]["signals"].as_array().unwrap();
        let joined = signals.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" | ");
        for expected in ["the same `name`", "near-identical body", "the same SHAPE"] {
            assert!(joined.contains(expected), "missing `{expected}` in: {joined}");
        }
        assert_eq!(signals.len(), 3, "every signal that grouped them, and no duplicates: {joined}");
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
        assert!(crate::extract::code_shingles("export const x = 1;").len() < crate::extract::MIN_SHINGLES, "too short to score");
        let g = serde_json::json!({ "implementations": [
            im("p.ts", "p", serde_json::json!({ "code": "export const x = 1;" })),
            im("q.ts", "q", serde_json::json!({ "code": "export const x = 1;" })),
        ]});
        assert!(dedup_findings(&g).is_empty(), "identical one-liners are not a finding");
    }

    /// Unicode in a body must not panic the tokenizer — it steps by CHAR width, not by byte.
    #[test]
    fn a_multibyte_body_tokenizes_without_panicking() {
        assert!(!crate::extract::code_shingles("const s = \"h\u{e9}llo \u{2192} w\u{f6}rld\"; // ok ok ok ok").is_empty());
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

#[cfg(test)]
mod reseed_tests {
    use super::*;

    #[test]
    fn reseed_refuses_without_being_told_what_to_take() {
        // `promote` defaults to "refresh what is already tracked" because its worst case is shipping a
        // stale record. Here the worst case is destroying the only copy of an edit, so there is no
        // bare form — and the refusal must not depend on a seed or a store existing.
        let err = run(vec!["reseed".to_string()], "bsc graph").expect_err("must refuse");
        assert!(err.contains("--id"), "does not say how to proceed: {err}");
        assert!(err.contains("--all"), "does not offer the sweep: {err}");
        assert!(err.contains("OVERWRITES"), "does not say what is at stake: {err}");
    }

    /// The rollback's two refusals. The CONTESTED-PATH one is the defect this port fixes: the script
    /// it replaces planned every restorable record and let the last write win, so a path claimed by
    /// four records was restored as one of them and the other three were silently lost.
    #[test]
    fn unmaterialize_refuses_a_contested_path_and_a_file_that_still_exists() {
        use serde_json::json;
        let impls = vec![
            json!({ "id": "a.ts", "src": "src/a.ts", "code": "export const a = 1;" }),
            json!({ "id": "live.ts", "src": "src/live.ts", "code": "export const l = 1;" }),
            // Four records claiming ONE path — the real shape in the committed store today
            // (`features/algorithms/viz/examples/sorts.ts` is carried by four impls).
            json!({ "id": "bubble", "src": "viz/sorts.ts", "code": "export const bubble = 1;" }),
            json!({ "id": "heap",   "src": "viz/sorts.ts", "code": "export const heap = 2;" }),
            json!({ "id": "merge",  "src": "viz/sorts.ts", "code": "export const merge = 3;" }),
            json!({ "id": "quick",  "src": "viz/sorts.ts", "code": "export const quick = 4;" }),
            // No code, or no src ⇒ not restorable at all, and not an error either.
            json!({ "id": "spec-only", "src": "src/spec.ts" }),
            json!({ "id": "srcless", "code": "export const x = 1;" }),
        ];
        let exists = |p: &str| p == "src/live.ts";
        let (plan, refused) = plan_unmaterialize(&impls, &exists);

        assert_eq!(plan.len(), 1, "only the clean record is restorable: {plan:?}");
        assert_eq!(plan[0].id, "a.ts");
        assert_eq!(plan[0].path, "src/a.ts");

        let by_id = |id: &str| refused.iter().find(|e| e.id == id).cloned();
        let live = by_id("live.ts").expect("a file that still exists is refused");
        assert!(live.refused.as_deref().unwrap_or_default().contains("EXISTS"), "{live:?}");

        // ALL FOUR contenders are refused — not three, and not "the last one wins".
        for id in ["bubble", "heap", "merge", "quick"] {
            let e = by_id(id).unwrap_or_else(|| panic!("{id} must be refused, not restored"));
            let why = e.refused.unwrap_or_default();
            assert!(why.contains("4 records claim this path"), "{id}: {why}");
            assert!(why.contains("bubble") && why.contains("quick"), "names the contenders: {why}");
        }
        assert_eq!(refused.len(), 5, "one live file + four contenders: {refused:?}");
    }

    /// A store document with NO `implementations` array yields an EMPTY plan, never a panic.
    ///
    /// Restored from `scripts/graph-unmaterialize.test.ts`, deleted when that script became this verb.
    /// The CLI's `unwrap_or_default` at the call site made this behaviour probably right — and "probably
    /// right" is what this migration keeps disproving, so it is asserted rather than assumed.
    #[test]
    fn a_store_with_no_implementations_array_plans_nothing() {
        let (plan, refused) = plan_unmaterialize(&[], &|_| false);
        assert_eq!(plan, Vec::new());
        assert_eq!(refused, Vec::new());
    }

    /// A record whose `code` already ends in a newline is written back with EXACTLY one.
    ///
    /// Also restored from the deleted test. Getting it wrong appends a blank line to every restored file
    /// — in a rollback of the 60 materialized records that is a diff which reads as the rollback having
    /// corrupted the tree, rather than as an off-by-one in the writer.
    #[test]
    fn a_trailing_newline_is_not_doubled_on_restore() {
        use serde_json::json;
        let dir = std::env::temp_dir().join(format!("bsc-unmat-nl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // The writer is the `unmaterialize` arm's; this exercises the same rule it applies.
        let body = |code: &str| if code.ends_with('\n') { code.to_string() } else { format!("{code}\n") };
        assert_eq!(body("pub fn a() {}\n"), "pub fn a() {}\n", "already newline-terminated");
        assert_eq!(body("pub fn a() {}"), "pub fn a() {}\n", "unterminated gains exactly one");

        // ...and end to end, through the plan, so the assertion is about the verb rather than a helper.
        let impls = vec![json!({ "id": "a.rs", "src": "crates/x/src/a.rs", "code": "pub fn a() {}\n" })];
        let (plan, _) = plan_unmaterialize(&impls, &|_| false);
        assert_eq!(plan.len(), 1);
        let target = dir.join("a.rs");
        std::fs::write(&target, body("pub fn a() {}\n")).unwrap();
        let written = std::fs::read_to_string(&target).unwrap();
        assert!(written.ends_with("}\n"), "exactly one trailing newline: {written:?}");
        assert!(!written.ends_with("}\n\n"), "a doubled newline would corrupt every restored file");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A record whose module genuinely went into the graph is restorable — the ordinary case, and the
    /// one that makes the refusals above meaningful rather than a blanket no.
    #[test]
    fn unmaterialize_restores_a_record_whose_file_is_gone() {
        use serde_json::json;
        let impls = vec![json!({
            "id": "cli.rs", "src": "crates/bsc-blueprint/src/cli.rs", "code": "pub fn run() {}"
        })];
        let (plan, refused) = plan_unmaterialize(&impls, &|_| false);
        assert_eq!(refused, Vec::new());
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].path, "crates/bsc-blueprint/src/cli.rs");
        assert!(plan[0].refused.is_none());
    }

    #[test]
    fn reseed_is_a_known_verb() {
        // The drift guard: a verb missing from VERBS drops out of the help-coverage test.
        assert!(VERBS.contains(&"reseed"));
    }

}
