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
fn ensure_sidecar_placeholder() {
    let target = env::var("TARGET").unwrap_or_default();
    if target.is_empty() {
        return;
    }
    let ext = if target.contains("windows") { ".exe" } else { "" };
    for name in ["bsc-plan", "bsc-agent", "bsc-research-mcp"] {
        let path = format!("binaries/{name}-{target}{ext}");
        if !Path::new(&path).exists() {
            let _ = fs::create_dir_all("binaries");
            let _ = fs::write(&path, b"");
        }
    }
}
