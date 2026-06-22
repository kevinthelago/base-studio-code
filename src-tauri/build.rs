use std::{env, fs, path::Path};

fn main() {
    ensure_sidecar_placeholder();
    tauri_build::build()
}

/// Tauri's `bundle.externalBin` makes the build script require
/// `binaries/bsc-plan-<target-triple><ext>` to exist on EVERY `cargo build` — but the real
/// binary is only staged during `tauri build` (beforeBuildCommand → scripts/stage-sidecar.mjs).
/// For a plain `cargo build`/`cargo test`/CI run we don't bundle anything, so drop an empty
/// placeholder when the real binary isn't staged, keeping the build (and the externalBin check)
/// green. `tauri build` stages the real binary first, so this never overwrites it. (#1089/#1091)
fn ensure_sidecar_placeholder() {
    let target = env::var("TARGET").unwrap_or_default();
    if target.is_empty() {
        return;
    }
    let ext = if target.contains("windows") { ".exe" } else { "" };
    let path = format!("binaries/bsc-plan-{target}{ext}");
    if !Path::new(&path).exists() {
        let _ = fs::create_dir_all("binaries");
        let _ = fs::write(&path, b"");
    }
}
