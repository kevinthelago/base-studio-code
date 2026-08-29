use std::{env, fs, path::Path};

/// Top-level `data/` dirs that are NOT config surfaces. MUST match `NON_CONFIG_DIRS` in
/// `src-tauri/build.rs` — both stage the same source tree and are pinned together by
/// `the_exclude_list_matches_src_tauris_own` in `src/lib.rs`, so the two embeds (this crate's and the
/// app's own) can never silently classify a surface differently.
const NON_CONFIG_DIRS: &[&str] = &["components", "knowledge"];

/// Stage the CONFIG-ONLY subset of `../../src-tauri/data` into `$OUT_DIR/config-seed`, embedded by
/// `include_dir!` in `src/lib.rs`.
///
/// A build script can't depend on a workspace lib for this (see `src-tauri/build.rs`'s own comment on
/// the point), so the staging logic is duplicated rather than shared — the two copies are pinned
/// together by the exclude-list test instead.
fn main() {
    let manifest = env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
    let out = env::var("OUT_DIR").expect("cargo sets OUT_DIR");
    let src = Path::new(&manifest).join("../../src-tauri/data");
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
            println!("cargo:rerun-if-changed={}", path.display());
            let _ = fs::copy(&path, dest.join(&name));
            continue;
        }
        if NON_CONFIG_DIRS.contains(&name.as_str()) {
            continue; // deliberately unwatched — mirrors src-tauri/build.rs
        }
        println!("cargo:rerun-if-changed={}", path.display());
        if let Err(e) = copy_tree(&path, &dest.join(&name)) {
            panic!("could not stage config surface `{name}`: {e}");
        }
    }
}

/// Recursively copy `src` into `dest`.
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
