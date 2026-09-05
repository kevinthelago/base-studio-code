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

/// The nearest ancestor of `manifest` (inclusive) that holds `graph/algorithms.json`.
///
/// NEAREST wins, deliberately: every nested worktree (`wt-<short>/`) is itself a checkout with its own
/// committed store, and a walk that preferred the outermost match would compile every worktree against
/// the root checkout's records.
///
/// This REPLACES `manifest.parent().and_then(Path::parent).expect("crates/<name> is two deep")`, which
/// was correct for exactly one shape and silently wrong — resolving OUTSIDE the repo — for every other.
pub fn repo_root_by_walk(manifest: &Path) -> Result<PathBuf, String> {
    let mut dir = Some(manifest);
    while let Some(d) = dir {
        if d.join("graph").join("algorithms.json").is_file() {
            return Ok(d.to_path_buf());
        }
        dir = d.parent();
    }
    Err(format!(
        "no `graph/algorithms.json` in {} or any ancestor of it — graph materialization needs the \
         COMMITTED store, which is what makes a fresh clone, CI and every nested worktree build. Pass \
         an explicit root if this crate lives outside the repo.",
        manifest.display()
    ))
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
    let store_path = repo_root.join("graph").join("algorithms.json");
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
    for f in ["build.rs", "plan.rs", "emit.rs"] {
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
                Some(Unit { id: id.to_string(), path, code: i.get("code")?.as_str()?.to_string(), vis, attrs })
            })
            .collect();
        // Deterministic order: cargo reruns this on every store change and a shuffled output would
        // recompile the crate for no reason. `render` sorts by module PATH, which is that order.
        mine.sort_by(|a, b| a.path.cmp(&b.path));
        mine
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
        if mine.is_empty() {
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
        render(mine, &self.crate_dir, &self.src_prefix, PREAMBLE).map(Some)
    }
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
    for p in &plan.rerun {
        println!("cargo:rerun-if-changed={}", p.display());
    }
    let raw = std::fs::read_to_string(&plan.store_path)
        .map_err(|e| format!("cannot read the committed graph store at {}: {e}", plan.store_path.display()))?;
    let Some(body) = plan.render_store(&raw, adoption)? else { return Ok(0) };
    let modules = body.lines().filter(|l| l.trim_start().starts_with("// record `")).count();
    let dest = out_dir.join("crate.rs");
    std::fs::write(&dest, body).map_err(|e| format!("cannot write {}: {e}", dest.display()))?;
    Ok(modules)
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
