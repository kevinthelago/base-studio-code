//! Small filesystem utilities (#1300) — project-key sanitization, path-escape guarding, recursive
//! text-file reads, and plan section-file ingestion. Pure-ish helpers shared across domains.
//! Extracted verbatim from `lib.rs`.

/// Sanitize a project key into a filesystem-safe slug.
///
/// Must stay byte-for-byte identical to the frontend's paneId sanitization in
/// Planning.tsx (`replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 80)`) so the PTY id and
/// the planning directory always correspond. ASCII-only on purpose — Rust's
/// `char::is_alphanumeric` accepts Unicode letters, which the JS regex does not.
pub(crate) fn sanitize_project_key(key: &str) -> String {
    let s: String = key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .collect();
    // Truncate so paths stay manageable.
    s.chars().take(80).collect()
}

/// Slugify a worktree/branch reference: keep `[A-Za-z0-9._-]`, every other char becomes `-`.
///
/// Must stay identical to the frontend `worktreeSlug` AND be the single source of truth on the Rust
/// side — the fleet uses it to *create* a worktree's on-disk path while session discovery uses it to
/// *recompute* that path; if the two ever diverged, recovery would miss live worktrees (#1300).
pub(crate) fn worktree_slug(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '-' })
        .collect()
}

/// Whether `rel` is a safe relative path: not absolute, with no drive prefix, root component, or any
/// `..` segment. Shared by the pipeline file primitives so a pipeline can never write/read outside
/// its own project dir.
pub(crate) fn is_safe_relpath(rel: &std::path::Path) -> bool {
    !rel.is_absolute()
        && !rel.components().any(|c| matches!(
            c,
            std::path::Component::ParentDir
                | std::path::Component::Prefix(_)
                | std::path::Component::RootDir
        ))
}

/// Recursively read every (text) file under `root` as `(relpath → contents)`, capped at
/// 512 KiB each, skipping unreadable/binary files. relpaths are forward-slashed and
/// relative to `root`. The generic complement to `read_skeleton_dir` (which filters by
/// extension) — pipelines persist arbitrary file types (`.vue`, `.svg`, `.html`, …).
pub(crate) fn read_files_dir(root: &std::path::Path) -> Vec<(String, String)> {
    fn walk(base: &std::path::Path, dir: &std::path::Path, out: &mut Vec<(String, String)>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(base, &p, out);
            } else {
                let small = std::fs::metadata(&p).map(|m| m.len() <= 512 * 1024).unwrap_or(false);
                if small {
                    if let (Ok(rel), Ok(content)) = (p.strip_prefix(base), std::fs::read_to_string(&p)) {
                        out.push((rel.to_string_lossy().replace('\\', "/"), content));
                    }
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Ingest every non-empty `.md`/`.json` section file in `dir` (top level only), keyed by
/// file stem, into `sections` — skipping the workspace control files. Used to read the hub
/// root + the `context/` subdir; a later call overrides earlier keys (context/ wins, #807).
pub(crate) fn ingest_section_files(dir: &std::path::Path, sections: &mut std::collections::HashMap<String, String>) {
    const CONTROL: &[&str] = &["CLAUDE.md", "kb_index.md", "automations.md", "extensions.md", "github_context.md"];
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() { continue; }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if CONTROL.contains(&name) { continue; }
        if !matches!(path.extension().and_then(|e| e.to_str()), Some("md") | Some("json")) { continue; }
        if let (Some(stem), Ok(content)) =
            (path.file_stem().and_then(|s| s.to_str()), std::fs::read_to_string(&path))
        {
            let content = content.trim().to_string();
            if !content.is_empty() {
                sections.insert(stem.to_string(), content);
            }
        }
    }
}
