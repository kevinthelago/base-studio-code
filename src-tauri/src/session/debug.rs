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

/// Re-stage the dev sidecars and retire the warm `bsc`, so a freshly built binary goes live WITHOUT an
/// app restart (#a-resolved-request-goes-live-without-a-restart).
///
/// This is the trigger the swap machinery was missing, not new machinery. `stage_dev_sidecars` already
/// does the whole job and is already idempotent — including the Windows dance a live sidecar forces: a
/// running `.exe` cannot be overwritten, but it CAN be renamed, so a locked image is parked as
/// `.old-<stamp>` and the new one copied into its place, rolled back if that copy fails. It was simply
/// only ever called at startup.
///
/// Retiring the warm child is the half that staging does NOT cover. It holds an already-mapped image, so
/// replacing the file on disk leaves it answering from the old code indefinitely; every OTHER `bsc` call
/// re-resolves `$BSC_BIN` per exec and picks the new binary up for free.
///
/// ORDER MATTERS: stage first, then retire. The reverse would leave a window where the child respawns
/// from the OLD binary and has to be retired a second time.
///
/// A long-lived `bsc mcp …` server keeps the old image until its session restarts — renaming does not
/// change an already-mapped process. That is a known and accepted gap (the maintainer expects MCP servers
/// to fall out of use in favour of the integration node/persona/role), not an oversight.
///
/// Returns each sidecar and where it now resolves — `None` for one that is not built, so a caller that
/// reloads and gets `bsc: null` learns the binary is MISSING rather than silently reloading nothing. In a
/// release bundle this is a no-op: sidecars sit beside the exe, there is no build output to stage, and
/// `stage_dev_sidecars` returns early.
#[tauri::command]
pub(crate) fn reload_sidecars() -> Vec<(String, Option<String>)> {
    crate::console::pty::stage_dev_sidecars();
    crate::console::bsc_warm::retire();
    crate::console::pty::sidecar_status()
        .into_iter()
        .map(|(name, path)| (name.to_string(), path.map(|p| p.to_string_lossy().into_owned())))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reload_is_safe_to_call_and_reports_the_sidecars() {
        // The command must never panic or leave the warm child in a half-retired state — it is called
        // from a poll loop the moment a request resolves, on machines with and without a build output.
        // Calling it twice pins idempotence: staging a second time is a plain copy, and retiring an
        // already-retired child is a no-op rather than an error.
        let first = reload_sidecars();
        let second = reload_sidecars();
        assert_eq!(
            first.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>(),
            second.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>(),
            "the reported sidecar set is stable across reloads",
        );
    }

    #[test]
    fn repo_root_is_the_parent_of_the_manifest_dir_on_the_build_host() {
        // On the machine that compiled this, the baked source tree exists → Some, and it's the repo
        // root (it has a `src-tauri` child).
        let root = debug_repo_root().expect("repo root on the build host");
        assert!(Path::new(&root).join("src-tauri").is_dir(), "the parent of CARGO_MANIFEST_DIR is the repo root");
    }
}
