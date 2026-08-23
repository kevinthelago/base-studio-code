//! The one way a studio workspace is created — shared by all five `setup_*_workspace` commands.
//!
//! Every studio had the same twelve lines: make a directory, load a packaged spec, write it as
//! `CLAUDE.md`. They also shared two defects, which is what this module exists to fix ONCE rather
//! than five times.
//!
//! ## 1. The context belongs in the file, not in the chat
//! A studio's persona and scope used to arrive as `paneStartupPromptText`, which `plan_launch` bakes
//! as claude's FIRST MESSAGE. That makes identity indistinguishable from conversation: it is re-sent
//! on every launch, it occupies the exchange the user is trying to have, and it is the first thing a
//! long session forgets. `CLAUDE.md` is what a harness reads as CONTEXT, and the workspace already
//! had one — the spec — so the session-specific part is appended to it instead.
//!
//! The composition happens in the FRONTEND and arrives here as `context`: the persona text lives in
//! the store and the scope is a property of the studio definition, so TypeScript is where both are
//! known. This module owns the FILE; it does not own what goes in it.
//!
//! ## 2. One directory per technology
//! `designerReact` and `designerReactNative` both resolved `design_dir`, and the three librarians all
//! resolved `algorithms_dir`. One directory means one `CLAUDE.md`, so it cannot carry a
//! per-technology scope — and it means one CWD, which matters more than it looks: Claude Code keys
//! its conversation history on the working directory, so two sessions sharing one would resume EACH
//! OTHER's conversation. A `tech` sub-directory gives each its own spec and its own history.

use crate::StrErr;
use std::path::{Path, PathBuf};

/// Create a studio's workspace and write its `CLAUDE.md`.
///
/// * `base`  — the app data dir.
/// * `name`  — the studio's directory (`design-studio`, `algorithms-studio`, …).
/// * `tech`  — the technology sub-directory, for a studio whose store is partitioned. `None` (or
///   empty) keeps the flat layout the single-technology studios have always had.
/// * `seed`  — the packaged spec key (`designer/claude.md`), config-dir overridable.
/// * `context` — the session-specific prose appended after the spec: who this session is, what it
///   owns, how to see what the user is looking at. Empty is fine and writes the spec alone.
pub(crate) fn setup_studio_workspace(
    base: &Path,
    name: &str,
    tech: Option<&str>,
    seed: &str,
    context: Option<&str>,
) -> Result<PathBuf, String> {
    let dir = match tech.map(str::trim).filter(|t| !t.is_empty()) {
        // Sanitized rather than trusted: this reaches the filesystem, and the value arrives from the
        // frontend. A technology is a slug (`react`, `react-native`, `typescript`) — anything else
        // would be a bug upstream, and a traversal is not the way to find out about it.
        Some(t) => base.join(name).join(sanitize_tech(t)),
        None => base.join(name),
    };
    std::fs::create_dir_all(&dir).str_err()?;
    let spec = crate::platform::config::load_str(seed);
    if spec.trim().is_empty() {
        return Err(format!("{seed} seed is missing or empty"));
    }
    std::fs::write(dir.join("CLAUDE.md"), compose(&spec, context)).str_err()?;
    Ok(dir)
}

/// Keep `[a-z0-9-]`, fold everything else to `-`. Never empty (an all-invalid input becomes `tech`),
/// because a directory named "" would silently collapse to the parent and re-create the sharing this
/// split exists to end.
fn sanitize_tech(t: &str) -> String {
    let s: String = t
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() { "tech".to_string() } else { s }
}

/// The spec, then the session's own context under a rule.
///
/// The separator matters: the spec is PACKAGED and the context is per-session, so a reader (human or
/// agent) needs to see where one ends. It also makes the file idempotent to rewrite — the whole thing
/// is regenerated on every panel open, exactly as it was before.
fn compose(spec: &str, context: Option<&str>) -> String {
    match context.map(str::trim).filter(|c| !c.is_empty()) {
        Some(c) => format!("{}\n\n---\n\n{}\n", spec.trim_end(), c),
        None => spec.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("bsc-studio-ws-{}-{tag}", std::process::id()))
    }

    #[test]
    fn a_technology_gets_its_own_directory_so_two_studios_cannot_share_a_conversation() {
        // THE BUG: both designers resolved one `design_dir`, so they shared a cwd — and Claude Code
        // keys its history on the cwd, so `--continue` would have resumed the other one's session.
        let base = scratch("tech");
        let cfg = base.join("config");
        crate::platform::config::with_config_root(&cfg, || {
            let a = setup_studio_workspace(&base, "design-studio", Some("react"), "designer/claude.md", None).unwrap();
            let b = setup_studio_workspace(&base, "design-studio", Some("react-native"), "designer/claude.md", None).unwrap();
            assert_ne!(a, b, "two technologies must not share a directory");
            assert_eq!(a, base.join("design-studio").join("react"));
            assert!(a.join("CLAUDE.md").is_file() && b.join("CLAUDE.md").is_file());
        });
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_single_technology_studio_keeps_its_flat_directory() {
        // The architect, sound-designer and integrator curate one store each. Giving them a
        // sub-directory would move their workspace — and their history with it — for no gain.
        let base = scratch("flat");
        let cfg = base.join("config");
        crate::platform::config::with_config_root(&cfg, || {
            for t in [None, Some(""), Some("   ")] {
                let d = setup_studio_workspace(&base, "teams-studio", t, "architect/claude.md", None).unwrap();
                assert_eq!(d, base.join("teams-studio"), "empty tech must not create a sub-directory");
            }
        });
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_context_lands_in_the_file_after_the_spec() {
        let base = scratch("ctx");
        let cfg = base.join("config");
        crate::platform::config::with_config_root(&cfg, || {
            let d = setup_studio_workspace(
                &base, "design-studio", Some("react"), "designer/claude.md",
                Some("## Your technology: react\n\nYou own the react kits."),
            ).unwrap();
            let md = std::fs::read_to_string(d.join("CLAUDE.md")).unwrap();
            let spec = crate::platform::config::load_str("designer/claude.md");
            assert!(md.starts_with(spec.trim_end()), "the packaged spec still leads");
            assert!(md.contains("You own the react kits."), "the session's context is IN THE FILE");
            assert!(md.contains("\n---\n"), "a reader can see where the packaged spec ends");
        });
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn rewriting_is_idempotent_because_it_happens_on_every_panel_open() {
        let base = scratch("idem");
        let cfg = base.join("config");
        crate::platform::config::with_config_root(&cfg, || {
            let a = setup_studio_workspace(&base, "design-studio", Some("react"), "designer/claude.md", Some("ctx")).unwrap();
            let first = std::fs::read_to_string(a.join("CLAUDE.md")).unwrap();
            let b = setup_studio_workspace(&base, "design-studio", Some("react"), "designer/claude.md", Some("ctx")).unwrap();
            assert_eq!(a, b);
            assert_eq!(first, std::fs::read_to_string(b.join("CLAUDE.md")).unwrap());
        });
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_hostile_technology_cannot_escape_the_studio_directory() {
        // `tech` arrives from the frontend and reaches the filesystem. It is a slug in every real
        // case; this is about what happens when it is not.
        assert_eq!(sanitize_tech("../../etc"), "etc");
        assert_eq!(sanitize_tech("react/../.."), "react");
        assert_eq!(sanitize_tech("REACT-Native"), "react-native");
        assert_eq!(sanitize_tech("../"), "tech", "an all-invalid tech must never yield an empty dir");
        assert_eq!(sanitize_tech("...."), "tech");
    }

    #[test]
    fn a_missing_seed_is_an_error_rather_than_an_empty_spec() {
        let base = scratch("noseed");
        let cfg = base.join("config");
        crate::platform::config::with_config_root(&cfg, || {
            let e = setup_studio_workspace(&base, "x-studio", None, "nope/claude.md", None).unwrap_err();
            assert!(e.contains("nope/claude.md"), "the error names the seed: {e}");
        });
        let _ = std::fs::remove_dir_all(&base);
    }
}
