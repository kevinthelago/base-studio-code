//! `bsc app hooks` — install the repo's git hooks into the COMMON `.git/hooks`.
//!
//! Ported from `scripts/install-hooks.mjs`.
//!
//! **EXPLICIT, never a postinstall**: a hook that refuses operations must be something you chose.
//!
//! `.git/hooks` lives in the common dir, so these govern EVERY worktree — which is the whole reason
//! the destination is `--git-common-dir` rather than the cwd's `.git`.

use crate::repo;
use std::path::{Path, PathBuf};

/// What an install did, so the caller reports names rather than a count.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Installed {
    pub dest: PathBuf,
    pub names: Vec<String>,
}

/// Copy every file in `<root>/scripts/hooks` into the common `.git/hooks`, executable.
pub fn install(root: &Path) -> Result<Installed, String> {
    let src = root.join("scripts").join("hooks");
    let common = repo::git(root, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
    let dest = PathBuf::from(common).join("hooks");
    std::fs::create_dir_all(&dest).map_err(|e| format!("could not create {}: {e}", dest.display()))?;

    let listing = std::fs::read_dir(&src)
        .map_err(|e| format!("could not read the hook source dir {}: {e}", src.display()))?;
    let mut names: Vec<String> = Vec::new();
    for entry in listing.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let to = dest.join(&name);
        std::fs::copy(entry.path(), &to)
            .map_err(|e| format!("could not install {name}: {e}"))?;
        make_executable(&to)?;
        names.push(name);
    }
    // Deterministic order, so the report reads the same twice and a test can compare whole values.
    names.sort();
    Ok(Installed { dest, names })
}

#[cfg(unix)]
fn make_executable(p: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("could not chmod {}: {e}", p.display()))
}

#[cfg(not(unix))]
fn make_executable(_p: &Path) -> Result<(), String> {
    // Windows has no execute bit; git runs a hook through its shell regardless.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installs_every_hook_into_the_common_dir_so_every_worktree_is_governed() {
        let root = repo::tests::scratch_repo("hooks");
        let src = root.join("scripts").join("hooks");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("pre-commit"), "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::write(src.join("reference-transaction"), "#!/bin/sh\nexit 0\n").unwrap();

        let got = install(&root).expect("install");
        assert_eq!(got.names, vec!["pre-commit", "reference-transaction"]);
        // THE COMMON DIR, not the worktree's own — that is what makes these govern every worktree.
        assert!(got.dest.ends_with(".git/hooks"), "dest was {:?}", got.dest);
        for name in &got.names {
            let p = got.dest.join(name);
            assert!(p.is_file(), "{name} was not installed");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    std::fs::metadata(&p).unwrap().permissions().mode() & 0o777,
                    0o755,
                    "{name} is not executable, so git would silently ignore it"
                );
            }
        }
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reports_a_missing_hook_source_rather_than_claiming_success() {
        let root = repo::tests::scratch_repo("hooks-missing");
        let err = install(&root).unwrap_err();
        assert!(err.contains("hook source dir"), "{err}");
        std::fs::remove_dir_all(&root).ok();
    }
}
