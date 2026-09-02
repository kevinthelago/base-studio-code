//! `bsc app rebuild` — rebuild and relaunch the whole app, from cold.
//!
//! Ported from `scripts/rebuild.mjs`.
//!
//! ## Why this exists
//!
//! `npm run build` does NOT update the running app, and that is the trap this closes. It runs
//! `tsc && vite build`, which writes `dist/` — and `dist/` is only read by `tauri build` (the
//! installer), never by `tauri dev`. The dev app serves its frontend from the vite dev server on
//! :1420 (`devUrl` in tauri.conf.json). So `npm run build` can succeed every time and change nothing
//! you can see.
//!
//! ## What updates what, normally
//!
//! ```text
//! src/**              vite HMR — instant, no command at all
//! src-tauri/data/**   the seed records; needs `emit-records` (this verb, or an app restart)
//! src-tauri/src/**    `tauri dev` watches Rust and rebuilds + restarts the app itself
//! crates/**           `npm run build:plan`, then RESTART the app so the sidecar is re-staged
//! ```
//!
//! In the normal case `npm run dev:app` already does all of that. This verb is for the case where
//! something is actually wedged: a stale record tree, a 0-byte binary from a killed build, a sidecar
//! that never got re-staged.
//!
//! ## What it deliberately does NOT do
//!
//! `cargo clean`. That discards ~20 GB and costs a full cold rebuild (~2 minutes for the binaries
//! alone, far longer for the app). Nothing here needs it: the record tree is regenerated from the
//! seed, and `verify-build-artifacts` already heals a truncated artifact.
//!
//! **IT STOPS on a real build error** rather than launching a stale app.

use std::path::{Path, PathBuf};

/// The process command lines this verb is allowed to kill, for a repo at `repo`.
///
/// ABSOLUTE paths only, never a bare name: `pkill -f base-studio-code` would match the developer's
/// editor, a grep for the string, and this very process.
pub fn kill_patterns(repo: &Path) -> Vec<String> {
    let r = repo.to_string_lossy();
    // VITE TOO. Without it a stale dev server survives the rebuild, keeps :1420, and the new
    // launch's `beforeDevCommand` fails on the port — then tauri attaches to the OLD server and
    // silently serves a stale frontend. Observed: a vite from 40 minutes earlier still holding the
    // port after a "successful" rebuild.
    vec![
        format!("{r}/target/debug/base-studio-code"),
        format!("{r}/node_modules/.bin/tauri"),
        format!("{r}/node_modules/.bin/vite"),
    ]
}

/// Should `cmd` be killed? A command line matches only by containing one of the absolute paths.
pub fn should_kill(cmd: &str, repo: &Path) -> bool {
    kill_patterns(repo).iter().any(|p| cmd.contains(p.as_str()))
}

/// Build artifacts that exist but are EMPTY — what a killed or OOM-ed link leaves behind.
///
/// Cargo will not rebuild one on its own: its fingerprint says the unit is current, so a plain
/// rebuild reports `Finished` and leaves the 0-byte file exactly where it was. Removing it is what
/// makes cargo disagree with its own fingerprint.
pub fn truncated_binaries(repo: &Path) -> Vec<PathBuf> {
    ["bsc", "bsc-agent", "bsc-hook", "base-studio-code"]
        .iter()
        .map(|b| repo.join("target").join("debug").join(b))
        .filter(|p| std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.len() == 0))
        .collect()
}

#[cfg(test)]
mod tests {
    //! Carried over from `scripts/rebuild.test.ts`, assertion for assertion.
    use super::*;

    fn repo() -> PathBuf {
        PathBuf::from("/home/dev/base-studio-code")
    }

    #[test]
    fn kills_the_app_binary_and_the_tauri_cli_for_this_repo() {
        let r = repo();
        assert!(should_kill("/home/dev/base-studio-code/target/debug/base-studio-code", &r));
        assert!(should_kill("node /home/dev/base-studio-code/node_modules/.bin/tauri dev", &r));
    }

    #[test]
    fn never_matches_a_bare_name() {
        // `pkill -f base-studio-code` is the obvious implementation and it is a trap: it matches the
        // developer's editor with the repo open, a grep for the string, and the rebuild itself.
        let r = repo();
        for innocent in [
            "base-studio-code",
            "vim /home/dev/base-studio-code/src/app/App.tsx",
            "grep -r base-studio-code .",
            "node scripts/rebuild.mjs",
            "/usr/bin/code --folder base-studio-code",
        ] {
            assert!(!should_kill(innocent, &r), "{innocent}");
        }
    }

    #[test]
    fn does_not_reach_into_another_checkout_of_the_same_repo() {
        // Worktrees and second clones are normal here. Killing another tree's app because it shares a
        // basename would stop work the user did not ask to stop.
        let r = repo();
        assert!(!should_kill("/home/dev/other-clone/target/debug/base-studio-code", &r));
        assert!(!should_kill("/home/dev/base-studio-code/wt-cred/target/debug/base-studio-code", &r));
    }

    #[test]
    fn kills_this_repos_vite_dev_server_and_no_other() {
        // Carried from `src/app/console/rebuildKillsVite.test.ts`, which imported the JavaScript from
        // the FRONTEND test tree — a caller a scripts-only survey does not find.
        //
        // A surviving vite keeps :1420, the new launch's beforeDevCommand fails on the port, and
        // tauri then attaches to the OLD server — a "successful" rebuild serving a stale frontend.
        let r = repo();
        assert!(should_kill("node /home/dev/base-studio-code/node_modules/.bin/vite", &r));
        // ...and the same two refusals hold for vite as for the app binary.
        assert!(!should_kill("vite", &r), "a bare name must never match");
        assert!(!should_kill("/home/dev/other/node_modules/.bin/vite", &r), "another checkout is not ours");
    }

    #[test]
    fn scopes_every_pattern_to_the_repo_it_was_given() {
        let r = repo();
        for p in kill_patterns(&r) {
            assert!(p.starts_with(&*r.to_string_lossy()), "{p}");
        }
        assert_ne!(kill_patterns(&r), kill_patterns(Path::new("/somewhere/else")));
    }

    #[test]
    fn finds_a_zero_byte_artifact_and_leaves_a_real_one_alone() {
        // The 0-byte case is the whole reason this step exists: cargo's fingerprint says the unit is
        // current, so a plain rebuild reports `Finished` and leaves the empty file in place.
        let root = std::env::temp_dir().join(format!(
            "bsc-app-trunc-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let debug = root.join("target").join("debug");
        std::fs::create_dir_all(&debug).unwrap();
        std::fs::write(debug.join("bsc"), b"").unwrap();
        std::fs::write(debug.join("bsc-agent"), b"real content").unwrap();

        let found = truncated_binaries(&root);
        assert_eq!(found.len(), 1, "found {found:?}");
        assert!(found[0].ends_with("bsc"));
        std::fs::remove_dir_all(&root).ok();
    }
}
