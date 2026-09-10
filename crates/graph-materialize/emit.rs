// THE IMPURE HALF of `crates/graph-materialize` — where the crate is on disk, where the repo root is,
// which records belong to it, and the one write.
//
// NOTE these are `//` comments and not `//!` module docs on purpose: this file is `include!`d (E0753),
// for the same reason `plan.rs` beside it is. See `src/lib.rs` for the crate-level documentation.
//
// # Why this file exists at all
//
// `crates/graph-materialize` used to be ONE FILE — a bare `build.rs` that 54 crates point their
// `build =` key at. That made it a shared FILE rather than a package, with two consequences that
// together kept `src-tauri` (141 files, 54,683 lines, zero records — the largest un-migrated body in
// the repo) out of the graph:
//
//   * it could not be taken as a `[build-dependencies]` entry and CALLED, and a package gets exactly
//     ONE build script — `src-tauri` already has its own, doing four jobs;
//   * its repo-root derivation was `manifest.parent().parent()` with `expect("crates/<name> is two
//     deep")`, so from `src-tauri` (ONE deep) it resolved to the repo's PARENT and every path was wrong.
//
// So the logic lives here and is `include!`d in TWO places: by `build.rs`, which is what the 54 existing
// adopters run, and by `src/lib.rs`, which is what a crate at any other depth takes as a
// build-dependency and calls. One implementation, two entry points — the same shape `plan.rs` already
// uses, and the reason the 54 keep emitting byte-identical output while `src-tauri` becomes adoptable.
//
// # Depth-independence, concretely
//
// Nothing below asks how deep the crate is. The repo root is found by walking UP from the manifest
// directory for `graph/algorithms.json` (nearest wins, which is what makes a nested worktree resolve to
// its OWN root rather than the parent checkout's), and the source prefix is then the manifest's path
// RELATIVE to that root plus `src/`. `crates/plandb` yields `crates/plandb/src/` exactly as the old
// hard-coded `format!("crates/{crate_dir}/src/")` did; `src-tauri` yields `src-tauri/src/`, which the
// old derivation could not express at all.

use std::path::{Path, PathBuf};

/// Everything resolved about ONE crate's materialization, before the store is read.
///
/// Separated from the emit itself so a test can assert where a crate at any depth resolves to without
/// a build, a temp store, or an `OUT_DIR` — which is the whole proof that `src-tauri` can adopt this.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// The repo root — the nearest ancestor of the manifest holding `graph/algorithms.json`.
    pub repo_root: PathBuf,
    /// `<repo_root>/graph/algorithms.json`, the COMMITTED store the build compiles from.
    pub store_path: PathBuf,
    /// The manifest directory's own name, which is what `expected_id` prefixes ids with —
    /// `plandb`, `bsc-news`, `src-tauri`.
    pub crate_dir: String,
    /// The repo-relative `src` prefix a record's `src` must start with — `crates/plandb/src/`,
    /// `src-tauri/src/`. Derived, never assumed.
    pub src_prefix: String,
    /// The files whose change must re-run the build script, in the order they are printed.
    pub rerun: Vec<PathBuf>,
}

/// Whether a crate that selected NO record is an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Adoption {
    /// The crate's `lib.rs` `include!`s the generated file, so an empty selection would produce an
    /// empty module and a wall of unresolved paths. Every one of the 54 existing adopters is this.
    Required,
    /// The crate does NOT `include!` the result yet — it is wired ahead of its first record, which is
    /// how `src-tauri` adopts without migrating a module in the same change. Zero records writes
    /// nothing and is not an error, but the store is STILL watched, because the alternative is that
    /// the first record ever authored does not reach the compiler and nothing says so.
    Optional,
}

/// The nearest ancestor of `manifest` (inclusive) that holds `graph/store.toml`.
///
/// THE MARKER IS NOT THE STORE, and that separation is the whole point of this function's shape.
/// Root discovery used to key on `graph/algorithms.json`, so the store file had a second job nobody
/// had named: retiring it broke root resolution for all 75 materialized crates INDEPENDENTLY of the
/// records they compile from (`retire-the-committed-json-record-store` measured that as its own
/// blocker). `graph/store.toml` exists only to answer "is this a repo root", so no future move of the
/// store can take root discovery down with it.
///
/// NEAREST wins, deliberately: every nested worktree (`wt-<short>/`) is itself a checkout with its own
/// committed store, and a walk that preferred the outermost match would compile every worktree against
/// the root checkout's records.
///
/// The legacy anchor is still accepted, and that is TRANSITIONAL rather than belt-and-braces: a
/// worktree checked out at a commit older than the marker has no `store.toml`, and refusing there
/// would break every parked tree in the pool the moment this lands. Drop the fallback once no branch
/// predates the marker.
///
/// This REPLACES `manifest.parent().and_then(Path::parent).expect("crates/<name> is two deep")`, which
/// was correct for exactly one shape and silently wrong — resolving OUTSIDE the repo — for every other.
pub fn repo_root_by_walk(manifest: &Path) -> Result<PathBuf, String> {
    let mut dir = Some(manifest);
    while let Some(d) = dir {
        let graph = d.join("graph");
        if graph.join("store.toml").is_file() || graph.join("algorithms.json").is_file() {
            return Ok(d.to_path_buf());
        }
        dir = d.parent();
    }
    Err(format!(
        "no `graph/store.toml` in {} or any ancestor of it — graph materialization needs the repo \
         root, and that marker is what makes a fresh clone, CI and every nested worktree find one. \
         Pass an explicit root if this crate lives outside the repo.",
        manifest.display()
    ))
}

/// Which store the build compiles from, named by `graph/store.toml`.
///
/// Read from the marker rather than hard-coded so `retire-the-committed-json-record-store` phase 3 is
/// a one-line change to a committed file instead of a code change in a build-dependency of 75 crates.
/// A missing or unreadable marker falls back to the historical name, for the same transitional reason
/// the walk above accepts the legacy anchor.
///
/// Deliberately a two-line parse and not a TOML dependency: this is a build-dependency of 75 crates
/// held to `serde_json` and nothing else, and the file is ours — one `key = "value"` line.
pub fn store_name(repo_root: &Path) -> String {
    let marker = repo_root.join("graph").join("store.toml");
    let text = match std::fs::read_to_string(&marker) {
        Ok(t) => t,
        Err(_) => return "algorithms.json".to_string(),
    };
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("store") {
            let rest = rest.trim_start();
            if let Some(v) = rest.strip_prefix('=') {
                let v = v.trim().trim_matches('"');
                if !v.is_empty() {
                    return v.to_string();
                }
            }
        }
    }
    "algorithms.json".to_string()
}

/// The repo-relative source prefix for a crate — `crates/plandb/src/`, `src-tauri/src/`.
pub fn src_prefix(repo_root: &Path, manifest: &Path) -> Result<String, String> {
    let rel = manifest.strip_prefix(repo_root).map_err(|_| {
        format!(
            "the crate at {} is not under the repo root {} — graph materialization cannot name its \
             records without a repo-relative path",
            manifest.display(),
            repo_root.display()
        )
    })?;
    let rel = rel.to_string_lossy().replace('\\', "/");
    let rel = rel.trim_matches('/').to_string();
    if rel.is_empty() {
        return Err(format!(
            "the manifest directory {} IS the repo root — a crate materialized from the graph must sit \
             in its own directory, because that directory's name is the id prefix of every record it owns",
            manifest.display()
        ));
    }
    Ok(format!("{rel}/src/"))
}

/// Resolve everything about a crate's materialization from its manifest directory alone.
///
/// `explicit_root` overrides the upward walk, for a crate that lives outside the checkout. It is a
/// PARAMETER rather than an environment read so that nothing here mutates process-global state — the
/// `set_var`/`remove_var` race that makes a test suite pass under `cargo nextest` (one process per
/// test) and fail under `cargo test` (threads in one process) is a trap this repo has paid for twice.
pub fn plan_for(manifest: &Path, explicit_root: Option<&Path>) -> Result<Plan, String> {
    let repo_root = match explicit_root {
        Some(r) => r.to_path_buf(),
        None => repo_root_by_walk(manifest)?,
    };
    let store_path = repo_root.join("graph").join(store_name(&repo_root));
    let crate_dir = manifest
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("{} has no directory name", manifest.display()))?
        .to_string();
    let src_prefix = src_prefix(&repo_root, manifest)?;

    // A record edit MUST reach the compiler — the cost files-to-zero accepted. Note this watches the
    // REPO store only: the packaged seed at src-tauri/data/knowledge/ is a different file and stays off
    // the Rust rebuild path, so `data-edits-must-not-rebuild-rust` (~28s -> 2.0s) still holds for the
    // UI/designer record edits it was won for. Verified: touching the seed compiles 0 crates.
    //
    // …and the sources of this materializer itself. Without them an edit to `plan.rs` changes what every
    // migrated crate compiles to and cargo rebuilds none of them — the silent-success failure this
    // crate's "failure is loud" section exists to avoid. They are named from the RESOLVED repo root
    // rather than as `<manifest>/../graph-materialize/…`, which only pointed at this directory from a
    // crate exactly two levels deep. Each is emitted only if it exists, so a checkout that has moved
    // this crate does not gain a watch on a path that will never change.
    let here = repo_root.join("crates").join("graph-materialize");
    let mut rerun = vec![store_path.clone()];
    for f in ["build.rs", "plan.rs", "emit.rs", "crate_root.rs"] {
        let p = here.join(f);
        if p.is_file() {
            rerun.push(p);
        }
    }

    Ok(Plan { repo_root, store_path, crate_dir, src_prefix, rerun })
}

impl Plan {
    /// The records in `store` that ARE whole modules of this crate, in the order `render` wants them.
    ///
    /// ONLY THE MODULE RECORD, never a function lifted out of the same file. Both carry the same `src`:
    /// `unquote.rs` is 8 lines lifted out of `crates/cve/src/install.rs`, while `cve--install.rs` IS
    /// that file. Selecting on `src` alone saw two records claiming module `install` and stopped the
    /// build. The discriminator is the id, and it is the same one `bsc graph emit` uses: a module
    /// record's id is DERIVED from its path, so it is exactly the statement "this record is that whole
    /// file". `plan.rs::expected_id` is that derivation, and
    /// `expected_id_agrees_with_extract_module_id` pins it against `extract::module_id` over every real
    /// path in this tree rather than asserting the two agree.
    pub fn select(&self, impls: &[serde_json::Value]) -> Vec<Unit> {
        let mut mine: Vec<Unit> = impls
            .iter()
            .filter_map(|i| {
                let src = i.get("src")?.as_str()?;
                let rest = src.strip_prefix(&self.src_prefix)?;
                // Which MODULE this file is, at ANY depth — `src/cli/nouns.rs` is `cli::nouns` and
                // `src/signals/mod.rs` is `signals`. `None` is the crate ROOT and a stray `src/mod.rs`;
                // see `plan.rs::module_path` for why `main.rs` counts as a root.
                let path = module_path(rest)?;
                let id = i.get("id")?.as_str()?;
                if id != expected_id(&self.crate_dir, rest) {
                    return None;
                }
                // HOW the module is declared travels on the record. `moduleVis` defaults to `pub`
                // because that was the only shape before this existed; `private` emits a bare `mod`.
                // `moduleAttrs` are emitted verbatim above the declaration, which is what keeps a
                // `#[cfg(feature = "…")]` gate intact — materialising a gated module without it makes
                // it unconditional, and that is a change to the program rather than to its formatting.
                let vis = match i.get("moduleVis").and_then(|v| v.as_str()) {
                    Some("private") | Some("") => String::new(),
                    Some(v) => format!("{v} "),
                    None => "pub ".to_string(),
                };
                let attrs: Vec<String> = i
                    .get("moduleAttrs")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                // The composes graph, carried on the record as the `imports` field the shared core added
                // (`imports-are-derived-from-the-composes-graph`). `render`/`emit_level` turn each entry
                // into a `use` line. Absent or empty ⇒ nothing generated and the record's own `use` lines
                // stand — the backward-compatible path every un-migrated record is still on.
                let imports: Vec<ImportSpec> = i
                    .get("imports")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|e| {
                                let from = e.get("from").and_then(|v| v.as_str())?.to_string();
                                let symbols = e
                                    .get("symbols")
                                    .and_then(|v| v.as_array())
                                    .map(|s| s.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                                    .unwrap_or_default();
                                let type_only = e.get("typeOnly").and_then(|v| v.as_bool()).unwrap_or(false);
                                let kind = e.get("kind").and_then(|v| v.as_str()).unwrap_or("named").to_string();
                                Some(ImportSpec { from, symbols, type_only, kind })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                // THE COMMAND FACET (`a-tauri-command-is-a-record-facet`). `#[tauri::command]` is not
                // formatting: it generates `__cmd__<name>` in the module that holds the function, and
                // the handler list resolves it there — so as body TEXT it pinned every command to its
                // module and made the 201-entry `generate_handler!` list a second statement of the
                // same set. As data, `render` re-attaches the attribute and builds the list from ONE
                // declaration. Absent ⇒ no commands, which is every record but ~72.
                let commands: Vec<TauriCommand> = i
                    .get("tauriCommands")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|e| {
                                let name = e.get("name").and_then(|v| v.as_str())?.to_string();
                                let args = e.get("args").and_then(|v| v.as_str()).map(str::to_string);
                                Some(TauriCommand { name, args })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                Some(Unit {
                    id: id.to_string(),
                    path,
                    code: i.get("code")?.as_str()?.to_string(),
                    vis,
                    attrs,
                    imports,
                    commands,
                })
            })
            .collect();
        // Deterministic order: cargo reruns this on every store change and a shuffled output would
        // recompile the crate for no reason. `render` sorts by module PATH, which is that order.
        mine.sort_by(|a, b| a.path.cmp(&b.path));
        mine
    }

    /// This crate's ROOT record — its documentation, and now its BODY.
    ///
    /// # Why the crate root's source is a record like everything else
    ///
    /// The crate root used to be the one file a migrated crate could not give up, and the stated
    /// reason was that `include!` refuses crate-level `//!` docs (E0753). That is true of an INCLUDED
    /// file and false of the real root: `#![doc = include_str!(concat!(env!("OUT_DIR"), "/crate_doc.md"))]`
    /// is a legal inner attribute in `crate_root.rs`, and `include_str!` resolves out of `OUT_DIR`,
    /// which is this script's to write. So the prose moved into the graph
    /// (`a-crate-root-is-shared-so-a-crate-is-one-file`).
    ///
    /// THAT LEFT THE ROOT'S PROGRAM BEHIND, and it was the larger half. `migrate-crate` moves DECLARED
    /// CHILDREN (`mod X;`); a crate whose whole implementation is its root has none, so five crates
    /// were not blocked but INVISIBLE — refused with "declares no modules — there is nothing to
    /// migrate". Letting this one record carry the body too
    /// (`the-crate-body-is-a-record-not-only-its-children`) is one capability that reaches every
    /// remaining root rather than 64 separate migrations. [`split_root`] does the split; the body lands
    /// at the top of `crate.rs` and the prose in `crate_doc.md`.
    ///
    /// SELECTED BY THE DERIVATION THAT ALREADY EXISTS, not by a new field. The record's `src` is the
    /// crate root's path (`crates/mcp-rpc/src/lib.rs`) and its id is `expected_id` of that path
    /// (`mcp-rpc--lib.rs`) — the same "this record IS that whole file" statement every module record
    /// makes. It can never be mistaken for a module because [`module_path`] already returns `None` for
    /// `lib.rs`/`main.rs`, so [`Plan::select`] skips it without knowing it exists.
    ///
    /// `main.rs` IS TRIED, and it is not a formality: `bsc-hook` is a binary whose whole 165-line
    /// program is its root, and a binary reaches the shared root through `[[bin]] path` exactly as a
    /// library does through `[lib] path`. `lib.rs` WINS when both exist, and it is deliberate rather
    /// than incidental: `$OUT_DIR` is per PACKAGE, not per target, so a package that migrated BOTH
    /// roots would need two `crate.rs` and get one. `bsc graph migrate-crate` cannot produce that
    /// state — `migrate::crate_root` picks `lib.rs` first, so the binary root of a package that also
    /// has a lib is never harvested — and this order is what makes the two agree about which root the
    /// generated file belongs to.
    ///
    /// `role: doc` is the record that holds PROSE AND NOTHING ELSE, which is what the eleven crates
    /// migrated before this change carry. Its `code` is markdown, never Rust, so it is taken verbatim
    /// and contributes no body — the discriminator is the role because that is what the role already
    /// means, and inventing a second field to say the same thing would let the two disagree.
    ///
    /// `None` means the crate has authored no root record, which is not an error: a crate that still
    /// owns a real `lib.rs` never reads this, and a crate mid-migration should get an empty rustdoc
    /// rather than a failed build.
    pub fn select_root(&self, impls: &[serde_json::Value]) -> Option<RootUnit> {
        for name in ["lib.rs", "main.rs"] {
            let want_src = format!("{}{name}", self.src_prefix);
            let want_id = expected_id(&self.crate_dir, name);
            let Some(rec) = impls.iter().find(|i| {
                i.get("src").and_then(|v| v.as_str()) == Some(want_src.as_str())
                    && i.get("id").and_then(|v| v.as_str()) == Some(want_id.as_str())
            }) else {
                continue;
            };
            let code = rec.get("code").and_then(|v| v.as_str()).unwrap_or_default();
            let role = rec.get("role").and_then(|v| v.as_str()).unwrap_or_default();
            return Some(if role == "doc" {
                RootUnit { id: want_id, doc: code.to_string(), body: None }
            } else {
                let (doc, body) = split_root(code);
                RootUnit { id: want_id, doc, body: Some(body) }
            });
        }
        None
    }

    /// This crate's own crate-level documentation, as the markdown that `crate_doc.md` holds.
    ///
    /// A thin read of [`Plan::select_root`], kept because the documentation is what the shared root
    /// asks for and the body is not — the two halves have different callers.
    pub fn select_doc(&self, impls: &[serde_json::Value]) -> Option<String> {
        self.select_root(impls).map(|r| r.doc)
    }

    /// The repo-relative prefix this crate's INTEGRATION TEST targets sit under —
    /// `crates/plandb/tests/`, `src-tauri/tests/`.
    ///
    /// DERIVED from [`Plan::src_prefix`] rather than stored beside it, so a `Plan` built by an older
    /// caller cannot be missing it and nothing that constructs one has to change.
    pub fn tests_prefix(&self) -> String {
        format!("{}tests/", self.src_prefix.strip_suffix("src/").unwrap_or(&self.src_prefix))
    }

    /// The `[[test]]` targets this crate's EDGES carry — the integration-test half of [`Plan::select`].
    ///
    /// # Why the EDGE tier and not `implementations`
    ///
    /// An integration test is a relationship: `wire_contract.rs` exercises four `bsc-lan-stream`
    /// modules together, and no single one of them owns it. That is precisely what an edge is — a
    /// `members` list plus the test that spans them — and it is why the tier existed with a store, a
    /// CLI and nothing that ran a test. This is what runs it.
    ///
    /// Selection mirrors [`Plan::select`] exactly: the edge's `src` must sit directly under this
    /// crate's `tests/`, and [`test_target_name`] must name a target (cargo auto-discovers `tests/*.rs`
    /// and nothing deeper). An edge belonging to another crate, or one whose provenance is a frontend
    /// `src/` path, is simply not this crate's and yields nothing.
    ///
    /// # Failure is loud, in one shape
    ///
    /// An edge carrying MORE THAN ONE test body has nowhere to put the second: a cargo test target is
    /// one file. Reporting it beats taking the first silently, which is how a migrated test stops
    /// running behind a green gate.
    pub fn select_test_targets(&self, edges: &[serde_json::Value]) -> Result<Vec<TestTarget>, String> {
        let prefix = self.tests_prefix();
        let mut out: Vec<TestTarget> = Vec::new();
        for e in edges {
            let Some(src) = e.get("src").and_then(|v| v.as_str()) else { continue };
            let Some(rest) = src.strip_prefix(&prefix) else { continue };
            let Some(name) = test_target_name(rest) else { continue };
            let id = e.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let bodies: Vec<&str> = e
                .get("tests")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|t| t.get("src").and_then(|v| v.as_str()))
                        .filter(|c| !c.trim().is_empty())
                        .collect()
                })
                .unwrap_or_default();
            match bodies.len() {
                // An edge with no carried test is a relationship recorded for its own sake — real, and
                // simply not a test target. Skipped, never an error.
                0 => continue,
                1 => out.push(TestTarget { id, name, code: bodies[0].to_string() }),
                n => {
                    return Err(format!(
                        "edge `{id}` carries {n} test bodies but names ONE cargo test target \
                         (`{prefix}{name}.rs`) — a test target is one file. Split it into one edge per \
                         file, or drop the extra bodies."
                    ))
                }
            }
        }
        // Deterministic order: cargo reruns this on every store change and a shuffled output would
        // rewrite files for no reason.
        out.sort_by(|a, b| a.name.cmp(&b.name));
        if let Some(dup) = out.windows(2).find(|w| w[0].name == w[1].name) {
            return Err(format!(
                "two edges claim test target `{}` of crate `{}`: `{}` and `{}`. One is superseded — \
                 remove it (`bsc graph edge remove <id>`) and re-promote.",
                dup[0].name, self.crate_dir, dup[0].id, dup[1].id
            ));
        }
        Ok(out)
    }

    /// The generated `crate.rs` body for this crate, given the store's raw JSON text.
    pub fn render_store(&self, raw: &str, adoption: Adoption) -> Result<Option<String>, String> {
        let store: serde_json::Value = serde_json::from_str(raw)
            .map_err(|e| format!("{} is not valid JSON: {e}", self.store_path.display()))?;
        let impls = store
            .get("implementations")
            .and_then(|v| v.as_array())
            .ok_or_else(|| format!("{} has no `implementations` array", self.store_path.display()))?;

        let mine = self.select(impls);
        // THE ROOT COUNTS AS A SELECTION. `mcp-rpc` owns exactly one record — its root — and reading
        // "no record" off the module list alone would have made the crate this capability exists for
        // fail its own build with the message for a crate that authored nothing.
        let root = self.select_root(impls);
        let root_body = root
            .as_ref()
            .and_then(|r| r.body.as_deref().filter(|b| !b.trim().is_empty()).map(|b| (r.id.as_str(), b)));
        if mine.is_empty() && root_body.is_none() {
            return match adoption {
                Adoption::Required => Err(format!(
                    "crate `{}` opted into graph materialization but no record in {} has a `src` under {}. \
                     Author one (`bsc graph impl set --src {}<module>.rs`) and `bsc graph promote --id <id>`.",
                    self.crate_dir,
                    self.store_path.display(),
                    self.src_prefix,
                    self.src_prefix
                )),
                Adoption::Optional => Ok(None),
            };
        }
        // The duplicate-module and missing-parent hard errors live in `render` — see `plan.rs`, which is
        // where a test can reach them. TWO RECORDS CLAIMING ONE MODULE is not a last-one-wins: it
        // happened, when renaming a record onto the path-derived id scheme left the superseded id in
        // the store with the same `src`, and the emitted `pub mod cli` twice reached the compiler as E0428.
        render(mine, root_body, &self.crate_dir, &self.src_prefix, PREAMBLE).map(Some)
    }
}

/// The per-record directory beside a store file — `graph/records/` beside `graph/algorithms.json`.
///
/// A directory, not a suffix rule: the layout mirrors `src-tauri/data/components/**`, where a record
/// has ALWAYS been one file, and it is what makes two branches editing two different records merge
/// without touching one line of the same file
/// (`epic-retire-json-ledgers-for-db-and-git-drivers`).
pub fn records_dir_beside(store_path: &Path) -> Option<PathBuf> {
    store_path.parent().map(|p| p.join("records"))
}

/// Load the committed record store, merging the store file with the per-record files under
/// `records/*.json` beside it.
///
/// THIS IS THE ONE DEFINITION every reader of the committed store must go through. A reader that
/// parses the store file alone silently sees an `implementations` array missing every split-out
/// record — and silently seeing less is this repo's signature failure, not a hypothetical one.
///
/// Each per-record file is ONE record object, appended to `implementations`; the files are read in
/// sorted order so the merged array is deterministic. A record lives in exactly ONE place, so there
/// is no precedence rule to get wrong. No `records/` dir means the store file is returned untouched,
/// which is what makes a temp store in a test a clean no-op.
///
/// Returns merged JSON TEXT rather than a `Value` because the materializer's consumers re-parse
/// `raw` anyway; [`load_merged_value`] is the parsed twin for callers that want the document.
/// The record DATABASE to read instead of the JSON store, when one is named.
///
/// `BSC_MATERIALIZE_FROM_DB` is an OPT-IN and takes a path, so both readers can run against the same
/// tree and be diffed — the JSON store stays the default until the two are proven to agree
/// (`retire-the-committed-json-record-store`). An empty value is treated as unset, because an exported
/// -but-empty variable is the shape a shell leaves behind and it must not silently disable the build's
/// only source of source.
#[allow(dead_code)]
pub fn record_db_override() -> Option<std::path::PathBuf> {
    db_override_from(std::env::var("BSC_MATERIALIZE_FROM_DB").ok().as_deref())
}

/// The opt-in's parse rule, kept PURE so it is testable without mutating process-global env.
///
/// A test that sets an env var races every sibling in the same binary (`cargo test` threads them),
/// and this repo has already paid for that once — so the rule lives here and the env read stays a
/// one-liner above it.
#[allow(dead_code)]
pub fn db_override_from(raw: Option<&str>) -> Option<std::path::PathBuf> {
    match raw {
        Some(v) if !v.trim().is_empty() => Some(std::path::PathBuf::from(v.trim())),
        _ => None,
    }
}

/// Is this file a SQLite database? By its MAGIC, never by its name.
///
/// `SQLite format 3\0` is the first sixteen bytes of every SQLite file and has been since 2004. An
/// extension check would call `records.db` a database and `records` not one, which is a difference the
/// store descriptor is explicitly allowed to make.
pub fn is_sqlite(path: &Path) -> bool {
    use std::io::Read;
    let mut f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut head = [0u8; 16];
    f.read_exact(&mut head).is_ok() && &head == b"SQLite format 3\0"
}

/// The merged store, assembled from the LEDGER rather than from `graph/records/*.json`.
///
/// The envelope (`edges`, `note`, `version`) still comes from `graph/algorithms.json` when that file
/// is present — the ledger holds RECORDS, and those sibling keys are not records. That split is why
/// this returns the same document shape rather than a bare array: every consumer downstream re-parses
/// `implementations` and would otherwise lose the edge table.
#[allow(dead_code)]
pub fn load_store_from_db(db_path: &Path, store_path: &Path) -> Result<String, String> {
    let lane = std::env::var("BSC_GRAPH_LANE").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "main".to_string());
    let records = read_lane_of(db_path, &lane, Some("impl"))?;
    let db_edges = read_lane_of(db_path, &lane, Some("edge"))?;

    // THE ENVELOPE COMES FROM A JSON STORE ONLY WHEN THERE IS ONE. Once `graph/store.toml` names the
    // database itself, `store_path` IS `db_path` — reading it as text then fails with "stream did not
    // contain valid UTF-8", which is what the first flip did to all 75 crates at once. The database
    // carries its own edges on the `edge` tier, so it needs no sibling file.
    let separate_json_envelope = store_path != db_path && store_path.exists() && !is_sqlite(store_path);
    let mut store: serde_json::Value = if separate_json_envelope {
        let raw = std::fs::read_to_string(store_path)
            .map_err(|e| format!("cannot read {}: {e}", store_path.display()))?;
        serde_json::from_str(&raw).map_err(|e| format!("{} is not valid JSON: {e}", store_path.display()))?
    } else {
        serde_json::json!({})
    };
    if !store.is_object() {
        return Err(format!("{} is not a JSON object", store_path.display()));
    }
    store["implementations"] = serde_json::Value::Array(records);
    // Only when the database HAS edges: under the transitional env override the JSON envelope still
    // carries them, and overwriting with an empty array would delete the relationship tier.
    if !db_edges.is_empty() {
        store["edges"] = serde_json::Value::Array(db_edges);
    }
    serde_json::to_string(&store).map_err(|e| format!("cannot serialize the store read from {}: {e}", db_path.display()))
}

pub fn load_merged_store(store_path: &Path) -> Result<String, String> {
    if let Some(db) = record_db_override() {
        return load_store_from_db(&db, store_path);
    }
    // THE STORE MAY ITSELF BE A DATABASE. `graph/store.toml` names a file, and the loader recognises
    // what that file IS rather than trusting its extension — a store renamed, or named without `.db`,
    // must not be read as JSON and reported as corrupt. Sixteen bytes of magic answer it exactly.
    if is_sqlite(store_path) {
        return load_store_from_db(store_path, store_path);
    }
    let raw = std::fs::read_to_string(store_path)
        .map_err(|e| format!("cannot read the committed graph store at {}: {e}", store_path.display()))?;
    let records_dir = match store_path.parent() {
        Some(p) => p.join("records"),
        None => return Ok(raw),
    };
    if !records_dir.is_dir() {
        return Ok(raw);
    }
    let mut store: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("{} is not valid JSON: {e}", store_path.display()))?;
    let impls = store
        .get_mut("implementations")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| format!("{} has no `implementations` array", store_path.display()))?;
    let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(&records_dir)
        .map_err(|e| format!("cannot read {}: {e}", records_dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("json"))
        .collect();
    files.sort();
    for p in files {
        let text = std::fs::read_to_string(&p)
            .map_err(|e| format!("cannot read {}: {e}", p.display()))?;
        let rec: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("{} is not valid JSON: {e}", p.display()))?;
        impls.push(rec);
    }
    serde_json::to_string(&store).map_err(|e| format!("cannot serialize the merged store: {e}"))
}

/// [`load_merged_store`] parsed — the shape a caller that wants the document, not the text, needs.
///
/// `Ok(None)` when the store file is ABSENT, which is not an error: a repo that has migrated nothing
/// yet has no store, and a caller must be able to tell that from "the store is corrupt".
///
/// `allow(dead_code)` because this file is ALSO `include!`d by `build.rs`, which is a binary crate
/// that materializes and never reads the document — an unreachable `pub` item there is dead code,
/// and this one exists for the LIBRARY consumers (`bsc-graph`'s repo store, `src-tauri`'s source
/// guards) that must not each re-implement the merge.
#[allow(dead_code)]
pub fn load_merged_value(store_path: &Path) -> Result<Option<serde_json::Value>, String> {
    if !store_path.exists() {
        return Ok(None);
    }
    let raw = load_merged_store(store_path)?;
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|e| format!("{} is not valid JSON: {e}", store_path.display()))
}

/// Materialize one crate: resolve, watch, read, render, write. The whole build script, minus the
/// environment.
///
/// Returns how many modules were emitted — `0` only under [`Adoption::Optional`], where nothing is
/// written. Taking the manifest, the output directory and the root as ARGUMENTS rather than reading
/// them from the environment is what lets the rules below be driven end to end by a test at any depth,
/// against a temp store, without a build and without mutating process-global state.
pub fn emit_into(
    manifest: &Path,
    out_dir: &Path,
    explicit_root: Option<&Path>,
    adoption: Adoption,
) -> Result<usize, String> {
    let plan = plan_for(manifest, explicit_root)?;
    // THE OPT-IN MUST INVALIDATE THE BUILD, or toggling it is silently inert. Cargo re-runs a build
    // script when a file it declared changed — it knows nothing about an env var unless told, so
    // without these two lines `BSC_MATERIALIZE_FROM_DB=… cargo check` reuses the JSON-store output and
    // reports success in 0.11s. MEASURED exactly that on the first end-to-end attempt, which is the
    // whole reason this comment exists: the flag appeared to work while doing nothing at all.
    println!("cargo:rerun-if-env-changed=BSC_MATERIALIZE_FROM_DB");
    println!("cargo:rerun-if-env-changed=BSC_GRAPH_LANE");
    for p in &plan.rerun {
        println!("cargo:rerun-if-changed={}", p.display());
    }
    // Merge the legacy single-file store with any per-record files under `graph/records/` — the
    // file-per-record layout (mirroring `src-tauri/data/components/**`) that retires the 27 MB
    // monolith (`epic-retire-json-ledgers-for-db-and-git-drivers`). A no-op until records are split
    // out, so this is transition-safe: a record lives in exactly one place at a time.
    // WATCH THE DATABASE WHEN IT IS THE SOURCE, or a record edit never reaches the compiler.
    //
    // The JSON path watches the record FILES below; the DB path had nothing, so changing the ledger
    // left every crate's cached build-script output in place. MEASURED: a `store import --refresh`
    // that moved 1,160 records was followed by a workspace check still failing on the PRE-refresh
    // bodies, which reads as "the reader is broken" rather than "nothing rebuilt".
    //
    // The whole file, not per-record: the ledger is one file and cargo can only watch paths. That is
    // coarser than the per-record watching the JSON path does — any record edit rebuilds every
    // materialized crate — and it is the honest cost of a single-file store, recorded here rather
    // than discovered later.
    if let Some(db) = record_db_override() {
        println!("cargo:rerun-if-changed={}", db.display());
    }
    let raw = load_merged_store(&plan.store_path)?;
    // THE PER-RECORD WATCH IS GONE, and it went with the file-per-record layout rather than being
    // dropped. While each record was `graph/records/<id>.json`, a crate named only the files whose
    // id begins `<crate>--` and a frontend `.ts` record edit rebuilt 0 crates instead of 77. A ledger
    // is ONE PATH and cargo can only watch paths, so `plan.rerun` names the store and every
    // materialized crate is invalidated by any record edit — MEASURED: 76 crates watch it, against 78
    // that own records and a median slice touching 4.
    //
    // Recorded here rather than discovered later, and NOT worked around: a stamp file per crate
    // maintained by the record writer would restore the narrowing, and its risk is the opposite and
    // worse one — a stale stamp means a crate does NOT rebuild when its own record changed. That is a
    // design decision, not a detail (`a-crate-watches-only-the-records-it-owns`).
    // The crate's own documentation, ALWAYS written — `crate_root.rs` `include_str!`s it
    // unconditionally, so a missing file is a compile error rather than an empty doc page, and a crate
    // that has authored no doc record yet must still build. Written BEFORE the module render can bail,
    // for the same reason.
    write_crate_doc(&plan, &raw, out_dir)?;
    // The crate's INTEGRATION TEST targets, also written BEFORE the module render can bail: a crate
    // may legitimately carry a test target while its modules are still files, and the `[[test]]`
    // entry in its manifest `include!`s the result unconditionally, so a missing file is a compile
    // error rather than an empty test.
    write_test_targets(&plan, &raw, out_dir)?;
    let Some(body) = plan.render_store(&raw, adoption)? else { return Ok(0) };
    let modules = body.lines().filter(|l| l.trim_start().starts_with("// record `")).count();
    let dest = out_dir.join("crate.rs");
    std::fs::write(&dest, body).map_err(|e| format!("cannot write {}: {e}", dest.display()))?;
    Ok(modules)
}

/// Write `$OUT_DIR/crate_doc.md` — the crate's own documentation, for the shared crate root's
/// `#![doc = include_str!(…)]` to pick up.
///
/// The file is written even when the crate has no doc record, because the shared root includes it
/// unconditionally; an absent record yields an empty page, never a broken build.
fn write_crate_doc(plan: &Plan, raw: &str, out_dir: &Path) -> Result<(), String> {
    let store: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| format!("{} is not valid JSON: {e}", plan.store_path.display()))?;
    let empty = Vec::new();
    let impls = store.get("implementations").and_then(|v| v.as_array()).unwrap_or(&empty);
    let doc = plan.select_doc(impls).unwrap_or_default();
    let dest = out_dir.join("crate_doc.md");
    std::fs::write(&dest, doc).map_err(|e| format!("cannot write {}: {e}", dest.display()))
}

/// Write `$OUT_DIR/tests/<name>.rs` for every integration-test target this crate's edges carry, for
/// the shared `crates/graph-materialize/test_root.rs` to `include!`.
///
/// Returns the target names written, so a caller (and a test) can see WHICH rather than only how many.
///
/// A crate with no test edges writes nothing and creates no directory — the overwhelming majority, and
/// an empty `tests/` dir under `$OUT_DIR` would be pure noise.
fn write_test_targets(plan: &Plan, raw: &str, out_dir: &Path) -> Result<Vec<String>, String> {
    let store: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| format!("{} is not valid JSON: {e}", plan.store_path.display()))?;
    let empty = Vec::new();
    // READ-ONLY on a key that may not exist: a store with no `edges` array is the normal shape for
    // every committed store that has never carried one, and asking must not be able to change that.
    let edges = store.get("edges").and_then(|v| v.as_array()).unwrap_or(&empty);
    let targets = plan.select_test_targets(edges)?;
    if targets.is_empty() {
        return Ok(Vec::new());
    }
    let dir = out_dir.join("tests");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let mut written = Vec::new();
    for t in &targets {
        let dest = dir.join(format!("{}.rs", t.name));
        std::fs::write(&dest, render_test_target(t))
            .map_err(|e| format!("cannot write {}: {e}", dest.display()))?;
        written.push(t.name.clone());
    }
    Ok(written)
}

/// The build-script entry point for a crate whose `lib.rs` `include!`s the generated file.
///
/// Failure is LOUD and there is deliberately no fallback to a file: the file is gone, and a build that
/// quietly produced an empty module is the silent-success failure this repo keeps paying for.
pub fn emit() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    emit_into(&manifest, &out_dir, None, Adoption::Required).unwrap_or_else(|e| panic!("{e}"));
}

/// The build-script entry point for a crate WIRED AHEAD OF ITS FIRST RECORD.
///
/// `src-tauri` is the case: it owns 141 files and zero records, and its `lib.rs` does not `include!`
/// anything, so [`emit`]'s hard error would be exactly wrong. This resolves and watches the store
/// identically, and writes nothing while the selection is empty.
///
/// THE STORE IS STILL WATCHED, and that is the deliberate part. Cargo's default "re-run when anything
/// in the package changes" is replaced the moment a build script prints ANY `rerun-if-changed`, and
/// `src-tauri`'s own build script already prints several for `data/` — so without this directive the
/// FIRST record ever authored for the crate would not re-run the script, would not reach the compiler,
/// and nothing would say so. The price is that a record edit anywhere then re-links the app; see the
/// crate docs.
pub fn emit_when_adopted() -> usize {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    emit_into(&manifest, &out_dir, None, Adoption::Optional).unwrap_or_else(|e| panic!("{e}"))
}
