// Git hooks (#265), extracted from lib.rs (#758).


/// One git hook in a repo. `active` = the hook file is present (a `.sample` doesn't
/// count). `source` is where the hooks live (the default `.git/hooks` or a
/// `core.hooksPath` like `.githooks`). `preview` is the first meaningful line.
#[derive(serde::Serialize)]
pub(crate) struct GitHook {
    name: String,
    active: bool,
    source: String,
    preview: String,
}

/// The standard git hooks we surface, in rough lifecycle order.
const GIT_HOOK_NAMES: &[&str] = &[
    "pre-commit", "prepare-commit-msg", "commit-msg", "post-commit",
    "pre-rebase", "post-checkout", "post-merge", "pre-push", "post-rewrite",
];

/// Extract `hooksPath` from a `.git/config` body (git honors it under `[core]`; we
/// accept it wherever it appears — close enough and avoids a full INI parser).
fn parse_hooks_path(cfg: &str) -> Option<String> {
    for line in cfg.lines() {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("hooksPath") {
            let v = rest.trim_start_matches(|c: char| c == '=' || c.is_whitespace()).trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// First non-shebang, non-comment, non-blank line of a hook script (truncated).
fn hook_preview(path: &std::path::Path) -> String {
    let content = std::fs::read_to_string(path).unwrap_or_default();
    for line in content.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with("#!") || l.starts_with('#') {
            continue;
        }
        return l.chars().take(120).collect();
    }
    String::new()
}

/// Read a repo's git hooks. Honors `core.hooksPath`, else `.git/hooks`. Returns the
/// standard hooks with whether each is active + a one-line preview. Best-effort: a path
/// without a `.git` directory yields an empty list (e.g. not cloned).
#[tauri::command]
pub(crate) fn read_git_hooks(repo_path: String) -> Vec<GitHook> {
    let root = std::path::PathBuf::from(&repo_path);
    let git_dir = root.join(".git");
    if !git_dir.is_dir() {
        return Vec::new();
    }
    let (hooks_dir, source) = std::fs::read_to_string(git_dir.join("config"))
        .ok()
        .and_then(|cfg| parse_hooks_path(&cfg))
        .map(|hp| {
            let p = if std::path::Path::new(&hp).is_absolute() {
                std::path::PathBuf::from(&hp)
            } else {
                root.join(&hp)
            };
            (p, hp)
        })
        .unwrap_or_else(|| (git_dir.join("hooks"), ".git/hooks".to_string()));

    GIT_HOOK_NAMES
        .iter()
        .map(|name| {
            let path = hooks_dir.join(name);
            let active = path.is_file();
            let preview = if active { hook_preview(&path) } else { String::new() };
            GitHook { name: (*name).to_string(), active, source: source.clone(), preview }
        })
        .collect()
}

#[cfg(test)]
mod tests {

    #[test]
    fn parse_hooks_path_reads_core_hookspath() {
        assert_eq!(
            super::parse_hooks_path("[core]\n\trepositoryformatversion = 0\n\thooksPath = .githooks\n"),
            Some(".githooks".to_string())
        );
        assert_eq!(super::parse_hooks_path("[core]\n\tbare = false\n"), None);
    }

    #[test]
    fn read_git_hooks_reports_active_hooks_and_skips_samples() {
        let dir = std::env::temp_dir().join(format!("bsc-hooks-{}", std::process::id()));
        let hooks = dir.join(".git").join("hooks");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&hooks).unwrap();
        std::fs::write(hooks.join("pre-commit"), "#!/bin/sh\n# header\ncargo fmt --check\n").unwrap();
        std::fs::write(hooks.join("pre-push.sample"), "#!/bin/sh\necho sample\n").unwrap();

        let out = super::read_git_hooks(dir.to_string_lossy().to_string());
        let pre_commit = out.iter().find(|h| h.name == "pre-commit").unwrap();
        assert!(pre_commit.active);
        assert_eq!(pre_commit.preview, "cargo fmt --check"); // shebang + comment skipped
        assert_eq!(pre_commit.source, ".git/hooks");
        // The `.sample` doesn't make pre-push active.
        assert!(!out.iter().find(|h| h.name == "pre-push").unwrap().active);

        // A path with no .git → empty.
        assert!(super::read_git_hooks(dir.join("nope").to_string_lossy().to_string()).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

