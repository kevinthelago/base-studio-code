use std::{env, fs, path::Path};

fn main() {
    ensure_sidecar_placeholder();
    stage_config_seed();
    ensure_bundled_seeds();
    tauri_build::build()
}

/// The seeds shipped as bundle RESOURCES, mirroring `bsc_util::packaged::RUNTIME_SEEDS`.
///
/// Duplicated here because a build script cannot depend on a workspace lib. A test pins the two
/// lists together, so drift fails the gate rather than shipping a binary missing a seed.
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
];

/// Stage the runtime-loaded seeds into `src-tauri/resources/data/…`, which is what
/// `bundle.resources` points at — NOT the live `data/` tree.
///
/// ## Why the indirection exists
///
/// `tauri_build` emits a `cargo:rerun-if-changed` for every `bundle.resources` entry. Pointing those
/// at `data/` therefore re-created exactly the coupling this work exists to remove: MEASURED, with
/// resources aimed at the source tree, touching `react-ui.json` rebuilt and relinked the app in
/// 23.2s; with the entries removed it was 1.2s and zero crates. Aiming them at a staged copy keeps
/// the seeds shipping while leaving the source tree unwatched.
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
    if let Ok(entries) = fs::read_dir(root.join("data").join("personas")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                seeds.push(format!("personas/{name}"));
            }
        }
    }

    for rel in &seeds {
        let dst = root.join("resources").join("data").join(rel);
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
        let path = format!("binaries/{name}-{target}{ext}");
        if !Path::new(&path).exists() {
            let _ = fs::create_dir_all("binaries");
            let _ = fs::write(&path, b"");
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
        names.push(entry.strip_prefix("binaries/").unwrap_or(entry).to_string());
        rest = &after[end + 1..];
    }
    assert!(
        !names.is_empty(),
        "externalBin must list at least one sidecar"
    );
    names
}
