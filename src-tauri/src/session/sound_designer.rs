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
        // #3479 — pin the config root for this thread; unpinned, `load_str` resolves through the
        // process-global home that `testutil::temp_home` repoints mid-run. See
        // `platform::config::with_config_root`.
        let cfg = base.join("config");
        crate::platform::config::with_config_root(&cfg, || {
            let dir = setup_sound_designer_workspace_inner(&base).unwrap();
            assert_eq!(dir, base.join("sound-studio"));
            let md = std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap();
            // The written spec is exactly the loaded seed (here the embedded default).
            assert_eq!(md, crate::platform::config::load_str("sound-designer/claude.md"));
            assert!(!md.trim().is_empty());
        });
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

    /// #3376 — the read-side companion to "Authoring: write, then apply". The seed must name the lean
    /// read verbs AND say WHY a redirect / chain / `$VAR` can never be allow-listed: a session that only
    /// learns "that was rejected" retries another variant of the same unmatchable shape.
    #[test]
    fn packaged_sound_designer_spec_teaches_reading_without_redirect_or_chain() {
        let seed = crate::platform::config::embedded_str("sound-designer/claude.md");
        for needle in [
            "Reading: never redirect, never chain",   // the section itself
            "bsc sound list --raw",                   // the byte-clean id list, not a dump-and-filter
            "bsc sound get <id>",                     // the one-record read
            "simple_expansion",                       // WHY a `$VAR` can never match a rule
            "**every** subcommand must match a rule", // WHY a `;` / `|` chain can never match
            "scratch/**",                             // WHY a redirect is out of scope anyway
        ] {
            assert!(seed.contains(needle), "sound-designer seed must teach the reading term `{needle}`");
        }
    }

    /// #3371 — the versioned release store is reachable from a sound-designer session with NO role
    /// change. The session launches `restrictedAllow` with the single granted surface `bsc sound`
    /// (`roleModel.ts`: `"sound-designer": ["bsc sound"]`), which `build_allow_rules` emits as
    /// `Bash(bsc sound *)`. That rule prefix-matches `bsc sound release …` exactly as it matches
    /// `bsc sound set`, so the designer can CUT a release from what it just authored without widening
    /// its surface by one rule. Asserted rather than assumed: `release` is a nested verb, and a
    /// narrower grant (`Bash(bsc sound set *)`-style, per-verb) would silently strand the publish step
    /// behind a permission prompt.
    #[test]
    fn sound_designer_grant_covers_the_release_verb_without_a_role_change() {
        use crate::session::settings::{write_session_settings, SessionSettingsSpec};
        let dir = scratch();
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();

        // The sound-designer launch shape (#3369): ONE granted command surface, baselines suppressed.
        const GRANT: &str = "bsc sound";
        write_session_settings(&SessionSettingsSpec {
            allowed_commands: &[GRANT.into()],
            restricted_allow: true,
            replace_permissions: true,
            bypass: false,
            ..SessionSettingsSpec::for_dir(&dir.to_string_lossy())
        })
        .unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".claude").join("settings.json")).unwrap())
                .unwrap();
        let allow: Vec<String> = v["permissions"]["allow"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap().to_string())
            .collect();

        // The grant is present in both invocation forms (#3359) and is the WHOLE Bash surface.
        assert!(allow.contains(&format!("Bash({GRANT} *)")), "granted with args: {allow:?}");
        assert!(allow.contains(&format!("Bash({GRANT})")), "granted bare: {allow:?}");
        assert!(!allow.iter().any(|r| r == "Bash"), "restrictedAllow emits no bare Bash: {allow:?}");

        // Claude Code's `Bash(<prefix> *)` matches any command starting with `<prefix> `. Every release
        // invocation the issue specifies is therefore auto-runnable under the EXISTING grant.
        let covered = |cmd: &str| {
            allow.iter().any(|rule| {
                rule.strip_prefix("Bash(")
                    .and_then(|r| r.strip_suffix(" *)"))
                    .is_some_and(|prefix| cmd.strip_prefix(prefix).is_some_and(|rest| rest.starts_with(' ')))
            })
        };
        for cmd in [
            "bsc sound release list",
            "bsc sound release get bsc/signal@1.0.0",
            "bsc sound release add bsc/neon 1.0.0 --from-store neon",
            "bsc sound release remove bsc/neon@1.0.0",
            "bsc sound release verify bsc/neon@1.0.0",
            "bsc sound set", // the pre-existing authoring verb still matches the same rule
        ] {
            assert!(covered(cmd), "`{cmd}` must auto-run under the sound-designer grant: {allow:?}");
        }
        // The surface did NOT have to grow: no per-verb `bsc sound release` rule was needed.
        assert!(
            !allow.iter().any(|r| r.contains("bsc sound release")),
            "release rides the existing `bsc sound` prefix — no extra grant: {allow:?}"
        );
        // …and the confinement still holds: a SIBLING store CLI is not reachable.
        assert!(!covered("bsc ui release list"), "the sound-designer never gains the UI store");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
