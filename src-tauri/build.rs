use std::{env, fs, path::Path};

fn main() {
    ensure_sidecar_placeholder();
    tauri_build::build()
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
