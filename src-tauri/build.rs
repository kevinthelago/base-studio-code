use std::{env, fs, path::Path};

/// Where the build's own outputs go: under `target/`, never inside `src-tauri/`.
///
/// Both paths are relative to `src-tauri/` — that is the build script's cwd AND `CARGO_MANIFEST_DIR`,
/// so one spelling serves [`ensure_sidecar_placeholder`] (which uses the cwd) and
/// [`ensure_bundled_seeds`] (which joins onto the manifest dir).
///
/// ## Why `../target` and not something derived
///
/// Cargo does not hand a build script the target directory. `OUT_DIR` contains it, but the number of
/// components to strip differs between a host build and a `--target <triple>` one, so walking up is a
/// guess that breaks on exactly the builds nobody runs locally. `.cargo/config.toml` settles the
/// question instead: it explicitly REJECTS a shared `CARGO_TARGET_DIR` ("it broke tauri builds before,
/// and it puts every concurrent cargo behind ONE target-dir lock"), so a per-worktree `<root>/target/`
/// is the layout this repo has chosen and pinned.
///
/// `tauri.conf.json` has to spell the same relative path in `externalBin` and every `bundle.resources`
/// key, so both sides already depend on that layout. Deriving it here would make them disagree without
/// making either correct.
const SIDECAR_DIR: &str = "../target/sidecars";
const BUNDLE_RESOURCE_DIR: &str = "../target/bundle-resources";

fn main() {
    ensure_sidecar_placeholder();
    stage_config_seed();
    ensure_bundled_seeds();
    materialize_graph_modules();
    tauri_build::build()
}

/// Materialize this crate's graph records into `$OUT_DIR/crate.rs`, the fifth job of a build script
/// that already had four.
///
/// ## Why this is a CALL and not a `build =` key
///
/// The other 54 migrated crates opt in with one line — `build = "../graph-materialize/build.rs"` —
/// pointing at a shared FILE. A package gets exactly ONE build script, and this one already has its
/// own (`ensure_sidecar_placeholder`, `stage_config_seed`, `ensure_bundled_seeds`,
/// `tauri_build::build`), so that route was closed. `graph-materialize` is now a real package as well
/// as a shared file — `build.rs` and `src/lib.rs` there `include!` the same `plan.rs` and `emit.rs` —
/// so calling it runs the identical source the other 54 compile, and this crate emits by exactly the
/// same rules.
///
/// Note this manifest has no `build` key at all; cargo auto-detects `build.rs`. That is why the
/// collision was invisible to anyone comparing manifests.
///
/// ## Why `emit_when_adopted` and not `emit`
///
/// `emit()` is a hard error when a crate opted in and owns no record, which is right for a crate whose
/// `lib.rs` `include!`s the result — an empty module would surface as a wall of unresolved paths
/// several steps downstream. `src-tauri` owns ZERO records today and its `lib.rs` `include!`s nothing,
/// so it is wired AHEAD of its first record: the selection is empty, nothing is written, and the build
/// is unaffected. The day a module is harvested into the store, this call starts emitting it.
///
/// ## What it costs, measured
///
/// It puts `graph/algorithms.json` on this crate's `rerun-if-changed` list — which it must, because
/// `stage_config_seed` above already prints rerun directives, and the first one printed REPLACES
/// cargo's default "re-run when anything in the package changes"; without this the first record ever
/// authored here would not re-run this script and nothing would say so.
///
/// The fear is that a record edit anywhere then re-links the app, which is the most expensive link in
/// the workspace. MEASURED 2026-09-04 in a warm worktree, BEFORE this call existed: `touch
/// graph/algorithms.json && cargo build -p base-studio-code` already recompiled 33 of this crate's
/// path dependencies and re-linked the app — 23.7s / 11.6s / 15.1s over three runs, ~1.64 GB peak RSS.
/// A third of the app's dependency tree materializes from that store, so the link was already being
/// paid on every record edit; what this adds is one build-script run.
fn materialize_graph_modules() {
    graph_materialize::emit_when_adopted();
}

/// The seeds shipped as bundle RESOURCES, mirroring `bsc_util::packaged::RUNTIME_SEEDS`.
///
/// Duplicated here because a build script cannot depend on a workspace lib. A test pins the two
/// lists together, so drift fails the gate rather than shipping a binary missing a seed.
/// Seed DIRECTORIES shipped whole, every `*.json` inside them.
///
/// `BUNDLED_SEEDS` names individual files; these name directories whose contents vary, so a file
/// list would be a second place to remember. `personas` was the original and stayed hardcoded in
/// `ensure_bundled_seeds`; `studios` and `skills` joined it when they moved off `include_dir!`
/// (`the-directory-seeds-must-actually-ship`) — until then they were compiled INTO the binary and so
/// needed no resource entry at all. Removing the embed without adding them here shipped a build with
/// no built-in Studio presets and no packaged skills, and every existing guard passed, because they
/// all key on `RUNTIME_SEEDS`, which has no way to name a directory.
const BUNDLED_SEED_DIRS: &[&str] = &["personas", "studios", "skills"];

const BUNDLED_SEEDS: &[&str] = &[
    "components/react-ui.json",
    "ui/react-ui-kit.meta.json",
    "knowledge/algorithms.json",
    // bsc-ui's seeds, moved off `include_str!`
    // (`the-bsc-ui-data-embeds-move-to-runtime-resolution`).
    "ui/primitives.json",
    "ui/themes.json",
    "ui/tokens-contract.css",
    "ui/style-descriptor.json",
    "ui/node-validation.fixtures.json",
    "stages/transformations.json",
    // plandb's validation taxonomies, moved off `include_str!`
    // (`the-plandb-data-embeds-move-to-runtime-resolution`).
    "deploy/taxonomy.json",
    "market/rubric.json",
    "transformations/taxonomy.json",
    "ui/preview-importmap.json",
    "ui/platform-modules.json",
    "sounds/signal.json",
    "fleet/defer-directive.md",
    "fleet/defer-stuck-directive.md",
];

/// Stage the runtime-loaded seeds into `target/bundle-resources/data/…`, which is what
/// `bundle.resources` points at — NOT the live `data/` tree.
///
/// The staged copy lives under `target/` because it is a BUILD OUTPUT and build output does not
/// belong inside the source tree (`epic-built-items-live-only-in-target`). Moving it there also took
/// it out of `tauri dev`'s watch scope for free — `.taurignore` never listed it, so the watcher was
/// carrying 9.7 MB of staged copy it could only ever see change as a result of its own build.
///
/// ## Why the indirection exists
///
/// `tauri_build` emits a `cargo:rerun-if-changed` for every `bundle.resources` entry. Pointing those
/// at `data/` therefore re-created exactly the coupling this work exists to remove: MEASURED, with
/// resources aimed at the source tree, touching `react-ui.json` rebuilt and relinked the app in
/// 23.2s; with the entries removed it was 1.2s and zero crates. Aiming them at a staged copy keeps
/// the seeds shipping while leaving the source tree unwatched. That property is the reason this
/// indirection exists AT ALL, so do not "simplify" it later by pointing the resource entries back at
/// `data/` — the staged copy moving to `target/` does not change the argument.
///
/// ## Why "if absent" and not "always"
///
/// Copying unconditionally would make this build script rewrite the resource whenever it ran, and
/// re-staging on every build is both wasted I/O and a fingerprint change. Refreshing is the RELEASE
/// path's job (`scripts/stage-sidecar.mjs`, the `beforeBuildCommand`), which re-copies on every
/// `tauri build`. This function only guarantees the files EXIST, because `tauri_build` fails the
/// build outright when a declared resource is missing — the same reason
/// [`ensure_sidecar_placeholder`] exists directly above.
///
/// Unlike that one, this writes the REAL bytes rather than an empty placeholder: an empty
/// `react-ui.json` would ship as a kit with no components, which reads as data loss rather than as a
/// missing file. A dev's copy may go stale between releases and that is harmless — nothing reads it
/// in dev, where `bsc_util::packaged` resolves the live checkout.
fn ensure_bundled_seeds() {
    let manifest = env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
    let root = Path::new(&manifest);
    // The fixed three, plus EVERY packaged persona. The personas are staged by scan rather than by a
    // hardcoded list because the list would be a second place to remember: adding a persona already
    // means adding a `bundle.resources` entry (which `every_packaged_persona_is_shipped_in_the_bundle`
    // enforces), and forgetting to stage it as well would fail the build with a missing resource
    // rather than anything that names the cause.
    let mut seeds: Vec<String> = BUNDLED_SEEDS.iter().map(|s| s.to_string()).collect();
    for dir in BUNDLED_SEED_DIRS {
        let Ok(entries) = fs::read_dir(root.join("data").join(dir)) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                seeds.push(format!("{dir}/{name}"));
            }
        }
    }

    for rel in &seeds {
        let dst = root.join(BUNDLE_RESOURCE_DIR).join("data").join(rel);
        if dst.exists() {
            continue;
        }
        let src = root.join("data").join(rel);
        if let Some(parent) = dst.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Err(e) = fs::copy(&src, &dst) {
            panic!(
                "could not stage bundled seed `{rel}` from {} to {}: {e}",
                src.display(),
                dst.display()
            );
        }
    }
}

/// Top-level `data/` dirs that are NOT config surfaces and must stay OUT of the embedded seed.
///
/// These hold the high-churn packaged blobs — `components/react-ui.json` (5.3 MB), the 388
/// `components/app/**` records, and `knowledge/algorithms.json` (2.6 MB). Together they are ~11 MB of
/// an ~11.5 MB tree, and every edit to one used to rebuild AND relink the app (measured: 20.5s
/// against a 1.3s no-op) purely because `include_dir!` swept the whole directory.
///
/// Excluding them is safe because NOTHING reads them through the config surface: every
/// `config::load_str`/`load_opt`/`embedded_str`/`embedded_dir_files` call names one of the prose/JSON
/// surfaces (`shell/`, `fleet/`, `permissions/`, `stages/`, `planner/`, …). `components/` was already
/// excluded from SEEDING for a separate reason (#2514), and `components/app/**` is served by the
/// component store via `BSC_COMPONENT_DIR`, not from here. `knowledge/` and the kit artifact are read
/// at runtime through `bsc_util::packaged`.
///
/// A test pins this list against the real `data/` tree, so adding a top-level dir forces a decision
/// rather than silently landing in the binary.
const NON_CONFIG_DIRS: &[&str] = &["components", "knowledge"];

/// Stage the CONFIG-ONLY subset of `data/` into `$OUT_DIR/config-seed`, which `platform/config.rs`
/// embeds instead of the raw tree.
///
/// ## Why the rerun directives are shaped the way they are
///
/// Emitting ANY `cargo:rerun-if-changed` replaces cargo's default ("rerun when anything in the
/// package changes"), so the list has to be complete or an edit to a config surface silently stops
/// reaching the binary — which is strictly worse than a slow build. The rule used here:
///
/// - one directive per INCLUDED top-level dir. Cargo scans a directory path recursively, so this
///   covers content edits, additions and deletions inside each config surface.
/// - **never** a directive for `data/` itself, and never one for an excluded dir. Watching `data/`
///   would recursively re-include `components/` and `knowledge/` and put the whole cost straight
///   back.
///
/// The one gap this leaves is a brand-new TOP-LEVEL dir under `data/`, which nothing watches. In
/// practice a new surface arrives with the Rust code that reads it, and that recompiles the crate
/// anyway; the paired test then fails until the dir is classified.
fn stage_config_seed() {
    let manifest = env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
    let out = env::var("OUT_DIR").expect("cargo sets OUT_DIR");
    let src = Path::new(&manifest).join("data");
    let dest = Path::new(&out).join("config-seed");

    // Wipe and re-stage so a DELETED source file cannot linger in the embedded tree.
    let _ = fs::remove_dir_all(&dest);
    if let Err(e) = fs::create_dir_all(&dest) {
        panic!("could not create the staged config seed at {}: {e}", dest.display());
    }

    // WATCH THE DATA ROOT ITSELF, not only the dirs inside it.
    //
    // The per-dir watches below are emitted for each directory THIS RUN SAW, so a directory that did
    // not exist on the previous run is in nobody's watch list: cargo does not re-run this script, the
    // staged tree keeps its old contents, and `EMBEDDED` has no entry for the new dir. Cargo re-runs
    // when a watched DIRECTORY's entries change, so watching the root is what makes a newly added
    // subdir visible the first time.
    //
    // MEASURED on `data/steward/`: `load_str("steward/claude.md")` returned empty for a file plainly on
    // disk, and the error read "seed is missing or empty" — a missing FILE, not a stale build. The
    // author usually stumbles into a rebuild and never sees it; a CLEAN checkout does not, which is how
    // this reached `.promote-gate` and blocked a promote while the authoring worktree stayed green.
    println!("cargo:rerun-if-changed={}", src.display());

    let entries = match fs::read_dir(&src) {
        Ok(e) => e,
        Err(e) => panic!("could not read the packaged data tree at {}: {e}", src.display()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_string) else {
            continue;
        };
        if !path.is_dir() {
            // No top-level files exist today; copy one if it ever appears rather than dropping it.
            println!("cargo:rerun-if-changed={}", path.display());
            let _ = fs::copy(&path, dest.join(&name));
            continue;
        }
        if NON_CONFIG_DIRS.contains(&name.as_str()) {
            continue; // deliberately unwatched — see the doc comment
        }
        println!("cargo:rerun-if-changed={}", path.display());
        if let Err(e) = copy_tree(&path, &dest.join(&name)) {
            panic!("could not stage config surface `{name}`: {e}");
        }
    }
}

/// Recursively copy `src` into `dest`. Errors propagate: a partially staged seed would present as a
/// missing surface at runtime, which is far harder to trace than a failed build.
fn copy_tree(src: &Path, dest: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let path = entry.path();
        let Some(name) = path.file_name() else { continue };
        if path.is_dir() {
            copy_tree(&path, &dest.join(name))?;
        } else {
            fs::copy(&path, dest.join(name))?;
        }
    }
    Ok(())
}

/// Tauri's `bundle.externalBin` makes the build script require each
/// `binaries/<name>-<target-triple><ext>` to exist on EVERY `cargo build` — but the real
/// binaries are only staged during `tauri build` (beforeBuildCommand → scripts/stage-sidecar.mjs).
/// For a plain `cargo build`/`cargo test`/CI run we don't bundle anything, so drop an empty
/// placeholder when the real binary isn't staged, keeping the build (and the externalBin check)
/// green. `tauri build` stages the real binaries first, so this never overwrites them. (#1089/#1091/#1117)
///
/// The name list is **derived from `tauri.conf.json`'s `externalBin`** (the canonical bundled-sidecar
/// set) rather than hand-maintained here, so adding a sidecar only means editing `externalBin`. (#1763)
fn ensure_sidecar_placeholder() {
    let target = env::var("TARGET").unwrap_or_default();
    if target.is_empty() {
        return;
    }
    let ext = if target.contains("windows") { ".exe" } else { "" };
    for name in sidecar_names() {
        let path = format!("{SIDECAR_DIR}/{name}-{target}{ext}");
        if !Path::new(&path).exists() {
            // Loudly: a placeholder that fails to appear surfaces later as `tauri_build` reporting a
            // missing resource, which names the path but not the reason. Both errors were swallowed
            // by `let _ =` and that cost a debugging round on exactly this function.
            if let Err(e) = fs::create_dir_all(SIDECAR_DIR) {
                panic!("could not create the sidecar staging dir {SIDECAR_DIR}: {e}");
            }
            if let Err(e) = fs::write(&path, b"") {
                panic!("could not write the sidecar placeholder {path}: {e}");
            }
        }
    }
}

/// The bundled-sidecar names, derived from `tauri.conf.json`'s `bundle.externalBin` with the
/// `binaries/` prefix stripped. `externalBin` is the single canonical list (#1763). Parsed with a
/// minimal string extraction so the build script needs no extra build-dependency: `externalBin` is a
/// flat JSON array of `"binaries/<name>"` string literals (no escapes), so we slice the array body and
/// pull each quoted entry.
fn sidecar_names() -> Vec<String> {
    const CONF: &str = include_str!("tauri.conf.json");
    let key = CONF
        .find("\"externalBin\"")
        .expect("tauri.conf.json must declare bundle.externalBin");
    let open = CONF[key..]
        .find('[')
        .map(|i| key + i + 1)
        .expect("externalBin must be a JSON array");
    let close = CONF[open..]
        .find(']')
        .map(|i| open + i)
        .expect("externalBin array must be closed");
    let body = &CONF[open..close];

    let mut names = Vec::new();
    let mut rest = body;
    while let Some(start) = rest.find('"') {
        let after = &rest[start + 1..];
        let end = after.find('"').expect("unterminated externalBin entry");
        let entry = &after[..end];
        // The NAME is the entry's basename. Taken that way rather than by stripping a known
        // directory prefix: the staged directory moved once already (`src-tauri/binaries/` ->
        // `target/sidecars/`), and a stale prefix here does not fail — it silently yields the whole
        // path as the "name", so the placeholder is written one directory too deep and `tauri_build`
        // reports the resource as missing with no hint about why.
        names.push(entry.rsplit('/').next().unwrap_or(entry).to_string());
        rest = &after[end + 1..];
    }
    assert!(
        !names.is_empty(),
        "externalBin must list at least one sidecar"
    );
    names
}
