//! The debug session's repo root (#3298, epic #3260). The debug session is a full-capability Claude
//! session cwd'd at the base-studio-code SOURCE tree, where it fixes `bsc ui` in response to the
//! `bsc request` queue. The source root is baked at compile time (`CARGO_MANIFEST_DIR`'s parent) and
//! returned ONLY if it still exists on disk — so on a machine other than the build host (a shipped
//! binary), it is `None` and the frontend simply doesn't launch the session (a graceful no-op).

use std::path::Path;

/// The base-studio-code repo root the debug session works in, or `None` when the baked source tree isn't
/// present (a shipped binary on another machine). `env!("CARGO_MANIFEST_DIR")` is `<repo>/src-tauri`.
#[tauri::command]
pub(crate) fn debug_repo_root() -> Option<String> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent()?;
    root.exists().then(|| root.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_root_is_the_parent_of_the_manifest_dir_on_the_build_host() {
        // On the machine that compiled this, the baked source tree exists → Some, and it's the repo
        // root (it has a `src-tauri` child).
        let root = debug_repo_root().expect("repo root on the build host");
        assert!(Path::new(&root).join("src-tauri").is_dir(), "the parent of CARGO_MANIFEST_DIR is the repo root");
    }
}
