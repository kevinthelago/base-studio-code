//! Sound-designer session workspace (#3369, epic #3071 phase 4) — the Sounds tab's dedicated,
//! heavily-restricted session. Mirrors the librarian workspace
//! (`session::librarian::setup_librarian_workspace`) exactly: one global workspace dir
//! (`~/.base-studio-code/sound-studio/`) whose `CLAUDE.md` is the sound-designer spec — the
//! primitive/voice/cue/kit model, the `bsc sound` contract, and the "sounds only" scope guard. The spec
//! prose is a packaged seed under `data/sound-designer/` (externalized-config pattern, #2027) loaded via
//! [`crate::platform::config::load_str`], so a user can edit it under the config dir with no rebuild.
//!
//! The session's permissions are NOT written here — the frontend renders the `sound-designer` role
//! capability (#219): none on every axis. It launches with `restrictedAllow: true`, so the whole
//! auto-runnable surface is `bsc sound`.

use crate::StrErr;

#[derive(serde::Serialize)]
pub(crate) struct SoundDesignerWorkspacePaths {
    // NB: Tauri does NOT rename RETURN-value fields — the frontend reads `sound_dir` verbatim.
    sound_dir: String,
}

/// Idempotently create the sound-designer workspace (`~/.base-studio-code/sound-studio/`) and
/// (re)write its `CLAUDE.md` from the packaged seed (`data/sound-designer/claude.md`, config-dir
/// overridable). Safe to call on every panel open — rewriting keeps the spec current with seed/config
/// updates, exactly as `setup_librarian_workspace` refreshes the librarian CLAUDE.md.
#[tauri::command]
pub(crate) fn setup_sound_designer_workspace() -> Result<SoundDesignerWorkspacePaths, String> {
    let dir = setup_sound_designer_workspace_inner(&crate::platform::paths::bsc_base_dir())?;
    Ok(SoundDesignerWorkspacePaths { sound_dir: dir.to_string_lossy().into_owned() })
}

/// Synchronous core of [`setup_sound_designer_workspace`] (testable without a Tauri runtime or the real
/// home dir): creates `<base>/sound-studio/` and writes its `CLAUDE.md` from the sound-designer seed.
pub(crate) fn setup_sound_designer_workspace_inner(base: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let dir = base.join("sound-studio");
    std::fs::create_dir_all(&dir).str_err()?;
    let spec = crate::platform::config::load_str("sound-designer/claude.md");
    if spec.trim().is_empty() {
        return Err("sound-designer/claude.md seed is missing or empty".to_string());
    }
    std::fs::write(dir.join("CLAUDE.md"), spec).str_err()?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "bsc-sound-designer-ws-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        ))
    }

    #[test]
    fn creates_the_workspace_and_writes_the_sound_designer_claude_md() {
        let base = scratch();
        let dir = setup_sound_designer_workspace_inner(&base).unwrap();
        assert_eq!(dir, base.join("sound-studio"));
        let md = std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap();
        // The written spec is exactly the loaded seed (config-dir copy or the embedded default).
        assert_eq!(md, crate::platform::config::load_str("sound-designer/claude.md"));
        assert!(!md.trim().is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn is_idempotent_and_refreshes_the_spec_on_recall() {
        let base = scratch();
        let dir = setup_sound_designer_workspace_inner(&base).unwrap();
        // Simulate a stale spec from an older app — a re-run must refresh it, not error.
        std::fs::write(dir.join("CLAUDE.md"), "STALE").unwrap();
        let again = setup_sound_designer_workspace_inner(&base).unwrap();
        assert_eq!(again, dir);
        let md = std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap();
        assert_ne!(md, "STALE", "recall must rewrite the spec from the seed");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The PACKAGED seed (ignoring any config-dir override) carries the content pillars the issue
    /// requires: the one command surface, the four-layer composition model, synthesis-first, and the
    /// scope guard.
    #[test]
    fn packaged_sound_designer_spec_carries_surface_model_and_scope_guard() {
        let seed = crate::platform::config::embedded_str("sound-designer/claude.md");
        assert!(!seed.trim().is_empty(), "data/sound-designer/claude.md must be packaged");
        for needle in [
            "bsc sound",       // the one command surface
            "bsc sound list",  // the discovery verbs
            "bsc sound get",
            "Primitive",       // the four-layer model
            "Voice",
            "Cue",
            "Kit",
            "synthesis",       // synthesis-first, never a binary asset
            "ONLY",            // the scope guard
        ] {
            assert!(seed.contains(needle), "sound-designer seed must mention `{needle}`");
        }
        // It must NOT hand the session a second store CLI — the restricted allow-list grants exactly one.
        for forbidden in ["bsc ui", "bsc graph", "bsc teams"] {
            assert!(
                !seed.contains(&format!("`{forbidden}`")),
                "sound-designer seed must not present `{forbidden}` as one of its surfaces",
            );
        }
    }
}
