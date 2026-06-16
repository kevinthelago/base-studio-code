// Document store listing (extracted from lib.rs, #758).
//
// Enumerates three kinds of markdown across the on-disk layout for the KB page, and
// reads/writes documents. Pure of Tauri beyond the command attrs.

use crate::{bsc_base_dir, PerfSpan};

// ── Document store listing ──────────────────────────────────────────────────
//
// The KB page enumerates three kinds of markdown across the on-disk layout:
//   - "reusable" — the flat library under `documents/**`
//   - "project"  — a project hub's own files under `projects/<p>/` (+ prompts/)
//   - "repo"     — only the managed CLAUDE.md / CLAUDE.local.md inside a clone
// `list_documents` walks the tree via `collect_documents`; per-document metadata
// (title, tags) is parsed from the same YAML-ish frontmatter setup_workspaces
// writes (`id`, `title`, `tags`).

/// Metadata for one markdown document surfaced to the KB page. Serialized to the
/// frontend with snake_case field names (Tauri's serde passes them through as-is).
#[derive(serde::Serialize)]
pub(crate) struct DocInfo {
    /// Posix path relative to `bsc_base_dir()` (forward slashes on every OS) so
    /// the frontend can pass it straight back to `read_document`/`write_document`.
    relpath:       String,
    /// File name including extension (e.g. `goal.md`).
    name:          String,
    /// Frontmatter `title:` if present, otherwise the file-name stem.
    title:         String,
    /// Taxonomy bucket: "reusable", "project", or "repo".
    kind:          String,
    /// Project key (the `projects/<proj>` segment) for "project" and "repo" kinds.
    project:       Option<String>,
    /// Repo short name (the `projects/<proj>/<repo>` segment) for the "repo" kind.
    repo:          Option<String>,
    /// Frontmatter `tags:` list, empty when absent.
    tags:          Vec<String>,
    size_bytes:    u64,
    modified_secs: u64,
}

/// Extracts `title` and `tags` from a document's leading YAML-ish frontmatter
/// block (a `---` fenced header as written by setup_workspaces). Returns
/// `(title, tags)` with `title` empty when no `title:` line is present so the
/// caller can fall back to the file-name stem. Best-effort and tolerant of
/// documents that have no frontmatter at all.
fn parse_frontmatter(content: &str) -> (String, Vec<String>) {
    let mut title = String::new();
    let mut tags: Vec<String> = Vec::new();
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return (title, tags);
    }
    // Take the lines between the opening `---` and the next `---`.
    let mut lines = trimmed.lines();
    lines.next(); // opening fence
    for line in lines {
        let line = line.trim();
        if line == "---" {
            break;
        }
        if let Some(rest) = line.strip_prefix("title:") {
            title = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("tags:") {
            // Accept either `[a, b]` or a bare comma list.
            let rest = rest.trim().trim_start_matches('[').trim_end_matches(']');
            tags = rest
                .split(',')
                .map(|t| t.trim().trim_matches('"').trim().to_string())
                .filter(|t| !t.is_empty())
                .collect();
        }
    }
    (title, tags)
}

/// Builds a `DocInfo` for `path` whose store-relative posix `relpath` and
/// `kind`/`project`/`repo` taxonomy are already known. Returns `None` if the file
/// is missing or its metadata can't be read.
fn doc_info_for(
    path: &std::path::Path,
    relpath: String,
    kind: &str,
    project: Option<String>,
    repo: Option<String>,
) -> Option<DocInfo> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let file_name = path.file_name().and_then(|n| n.to_str())?.to_string();
    let modified_secs = meta.modified().ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let content = std::fs::read_to_string(path).unwrap_or_default();
    let (fm_title, tags) = parse_frontmatter(&content);
    // settings.json carries no frontmatter — give it a stable display title.
    let title = if file_name == "settings.json" {
        "settings.json".to_string()
    } else if fm_title.is_empty() {
        path.file_stem().and_then(|s| s.to_str()).unwrap_or(&file_name).to_string()
    } else {
        fm_title
    };
    Some(DocInfo {
        relpath,
        name: file_name,
        title,
        kind: kind.to_string(),
        project,
        repo,
        tags,
        size_bytes: meta.len(),
        modified_secs,
    })
}

/// Recursively pushes every `.md` file under `dir` into `out` with the given
/// `kind`/`project`, computing each one's posix relpath against `base`.
/// `.claude/` directories are not descended into (their settings.json is added
/// explicitly by the caller).
fn collect_md_tree(
    base: &std::path::Path,
    dir: &std::path::Path,
    kind: &str,
    project: &Option<String>,
    out: &mut Vec<DocInfo>,
) {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let entries = match std::fs::read_dir(&d) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if path.is_dir() {
                if name == ".claude" {
                    continue; // settings.json handled explicitly
                }
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            if let Some(rel) = relpath_posix(base, &path) {
                if let Some(info) = doc_info_for(&path, rel, kind, project.clone(), None) {
                    out.push(info);
                }
            }
        }
    }
}

/// Posix-joined path of `path` relative to `base`, or `None` if `path` is not
/// under `base`.
fn relpath_posix(base: &std::path::Path, path: &std::path::Path) -> Option<String> {
    let rel = path.strip_prefix(base).ok()?;
    Some(
        rel.iter()
            .filter_map(|s| s.to_str())
            .collect::<Vec<_>>()
            .join("/"),
    )
}

/// Collects every surfaced document under `base` (= `bsc_base_dir()`):
///   - `documents/**/*.md`                                   → kind "reusable"
///   - `documents/.claude/settings.json`                     → kind "reusable"
///   - `projects/<p>/*.md`, `projects/<p>/prompts/**/*.md`   → kind "project"
///   - `projects/<p>/.claude/settings.json`                  → kind "project"
///   - `projects/<p>/<repo>/{CLAUDE.md,CLAUDE.local.md}`     → kind "repo"
///   - `projects/<p>/<repo>/.claude/settings.json`           → kind "repo"
///
/// A `projects/<p>/<repo>/` subdir is treated as a repo clone (kind "repo") iff
/// it contains a `.git` entry; only its managed files are surfaced — the clone's
/// source tree is never recursed. Sorted most-recently-modified first.
/// Factored out of the command so it can be unit-tested against a temp tree.
fn collect_documents(base: &std::path::Path) -> Vec<DocInfo> {
    let mut out: Vec<DocInfo> = Vec::new();

    // 1. Flat reusable library: documents/**/*.md (+ its .claude/settings.json).
    let docs = base.join("documents");
    if docs.is_dir() {
        collect_md_tree(base, &docs, "reusable", &None, &mut out);
        let settings = docs.join(".claude").join("settings.json");
        if let Some(rel) = relpath_posix(base, &settings) {
            if let Some(info) = doc_info_for(&settings, rel, "reusable", None, None) {
                out.push(info);
            }
        }
    }

    // 2. Project hubs: projects/<p>/.
    let projects = base.join("projects");
    if let Ok(entries) = std::fs::read_dir(&projects) {
        for entry in entries.flatten() {
            let pdir = entry.path();
            if !pdir.is_dir() {
                continue;
            }
            let pname = match pdir.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            let proj = Some(pname.clone());

            // Project-level *.md sitting directly in the hub.
            if let Ok(items) = std::fs::read_dir(&pdir) {
                for item in items.flatten() {
                    let path = item.path();
                    if path.is_file()
                        && path.extension().and_then(|e| e.to_str()) == Some("md")
                    {
                        if let Some(rel) = relpath_posix(base, &path) {
                            if let Some(info) =
                                doc_info_for(&path, rel, "project", proj.clone(), None)
                            {
                                out.push(info);
                            }
                        }
                    }
                }
            }

            // Project prompts/ subtree.
            let prompts = pdir.join("prompts");
            if prompts.is_dir() {
                collect_md_tree(base, &prompts, "project", &proj, &mut out);
            }

            // Project .claude/settings.json.
            let psettings = pdir.join(".claude").join("settings.json");
            if let Some(rel) = relpath_posix(base, &psettings) {
                if let Some(info) =
                    doc_info_for(&psettings, rel, "project", proj.clone(), None)
                {
                    out.push(info);
                }
            }

            // Repo clones: subdirs that contain a `.git` entry. Surface only the
            // managed CLAUDE.md / CLAUDE.local.md plus .claude/settings.json.
            if let Ok(subs) = std::fs::read_dir(&pdir) {
                for sub in subs.flatten() {
                    let rdir = sub.path();
                    if !rdir.is_dir() {
                        continue;
                    }
                    let rname = match rdir.file_name().and_then(|n| n.to_str()) {
                        Some(n) => n.to_string(),
                        None => continue,
                    };
                    if rname == ".claude" || rname == "prompts" {
                        continue;
                    }
                    if !rdir.join(".git").exists() {
                        continue; // not a clone — skip (don't recurse its tree)
                    }
                    let repo = Some(rname.clone());
                    for managed in ["CLAUDE.md", "CLAUDE.local.md"] {
                        let path = rdir.join(managed);
                        if path.is_file() {
                            if let Some(rel) = relpath_posix(base, &path) {
                                if let Some(info) = doc_info_for(
                                    &path, rel, "repo", proj.clone(), repo.clone(),
                                ) {
                                    out.push(info);
                                }
                            }
                        }
                    }
                    let rsettings = rdir.join(".claude").join("settings.json");
                    if let Some(rel) = relpath_posix(base, &rsettings) {
                        if let Some(info) =
                            doc_info_for(&rsettings, rel, "repo", proj.clone(), repo.clone())
                        {
                            out.push(info);
                        }
                    }
                }
            }
        }
    }

    out.sort_by_key(|d| std::cmp::Reverse(d.modified_secs));
    out
}

/// Absolute path of the base-studio-code data dir, so the frontend can build
/// project/repo session paths: `<base>/projects/<sanitized project>/<repo>`.
#[tauri::command]
pub(crate) fn get_base_dir() -> String {
    bsc_base_dir().to_string_lossy().into_owned()
}

/// Lists every surfaced markdown/settings document across the reusable library
/// (`documents/`), the project hubs (`projects/<p>/`), and the managed files in
/// each project's repo clones. Sorted most-recently-modified first.
#[tauri::command]
pub(crate) async fn list_documents() -> Result<Vec<DocInfo>, String> {
    let _perf = PerfSpan::new("list_documents");
    Ok(collect_documents(&bsc_base_dir()))
}

/// Validates a base-relative posix path for read/write: rejects `..` segments,
/// rejects absolute paths, and only permits paths under `documents/` or
/// `projects/`. Returns the resolved absolute path on success.
fn resolve_store_path(relpath: &str) -> Result<std::path::PathBuf, String> {
    if relpath.contains("..") {
        return Err("invalid relpath: contains '..'".to_string());
    }
    let normalized = relpath.replace('\\', "/");
    // Reject absolute paths (unix `/x`, windows `C:/x` or `\\server`).
    let is_absolute = normalized.starts_with('/')
        || std::path::Path::new(relpath).is_absolute()
        || (normalized.len() >= 2 && normalized.as_bytes()[1] == b':');
    if is_absolute {
        return Err("invalid relpath: must be relative".to_string());
    }
    if !(normalized.starts_with("documents/") || normalized.starts_with("projects/")) {
        return Err("invalid relpath: must begin with documents/ or projects/".to_string());
    }
    Ok(bsc_base_dir().join(relpath))
}

/// Reads one document by its base-relative posix path (as returned in
/// `DocInfo::relpath`). Path must be under `documents/` or `projects/` and must
/// not contain `..` (see [`resolve_store_path`]).
#[tauri::command]
pub(crate) async fn read_document(relpath: String) -> Result<String, String> {
    let path = resolve_store_path(&relpath)?;
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Writes `content` to a document at its base-relative posix path, creating
/// parent directories as needed. Same path guards as [`read_document`].
#[tauri::command]
pub(crate) async fn write_document(relpath: String, content: String) -> Result<(), String> {
    let path = resolve_store_path(&relpath)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Writes a comprehensive project plan markdown file to `.claude/project-plan.md`
/// inside each linked repository. Console Claude sessions can `Read` this file
/// to get full project context without needing to ask the user for it.
#[tauri::command]
pub(crate) async fn write_project_plan(content: String, repo_paths: Vec<String>) -> Result<(), String> {
    for path in &repo_paths {
        let claude_dir = std::path::PathBuf::from(path).join(".claude");
        std::fs::create_dir_all(&claude_dir).map_err(|e| e.to_string())?;
        std::fs::write(claude_dir.join("project-plan.md"), &content)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{ENV_LOCK, temp_home, write_file};

    #[test]
    fn parse_frontmatter_extracts_title_and_tags() {
        let (title, tags) = parse_frontmatter("---\nid: abc\ntitle: My Doc\ntags: [rust, react]\n---\n\nbody");
        assert_eq!(title, "My Doc");
        assert_eq!(tags, vec!["rust".to_string(), "react".to_string()]);
    }

    #[test]
    fn parse_frontmatter_empty_when_absent() {
        let (title, tags) = parse_frontmatter("# Just a heading\n\nno frontmatter");
        assert!(title.is_empty());
        assert!(tags.is_empty());
    }

    #[test]
    fn collect_documents_classifies_reusable_project_and_repo() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home = temp_home("collect");
        let base = home.join(".base-studio-code");
        let docs = base.join("documents");
        let proj = base.join("projects").join("proj-x");
        let repo = proj.join("api"); // short-name clone dir

        // Reusable library article with frontmatter.
        write_file(&docs.join("a1.md"),
            "---\nid: a1\ntitle: Alpha\ntags: [rust]\n---\n\nbody");
        // Reusable CLAUDE.md IS included (kind reusable).
        write_file(&docs.join("CLAUDE.md"), "# lib claude");
        // Reusable settings.json.
        write_file(&docs.join(".claude").join("settings.json"), "{}");

        // Project plan section (no title frontmatter → stem fallback).
        write_file(&proj.join("goal.md"), "the goal");
        // Project prompt.
        write_file(&proj.join("prompts").join("kickoff.md"), "go");
        // Project settings.json.
        write_file(&proj.join(".claude").join("settings.json"), "{}");

        // Repo clone: a `.git` entry marks it as a clone. Only managed files
        // are surfaced; the clone's own source tree must NOT be listed.
        write_file(&repo.join(".git").join("HEAD"), "ref: refs/heads/main");
        write_file(&repo.join("CLAUDE.md"), "# repo claude");
        write_file(&repo.join("CLAUDE.local.md"), "# repo local");
        write_file(&repo.join(".claude").join("settings.json"), "{}");
        // These are clone source files — they MUST be ignored.
        write_file(&repo.join("README.md"), "do not list me");
        write_file(&repo.join("src").join("deep.md"), "do not list me either");

        let found = collect_documents(&base);
        let by_rel = |rel: &str| found.iter().find(|d| d.relpath == rel);

        // Reusable.
        let a = by_rel("documents/a1.md").expect("reusable article present");
        assert_eq!(a.kind, "reusable");
        assert_eq!(a.project, None);
        assert_eq!(a.repo, None);
        assert_eq!(a.title, "Alpha");
        assert_eq!(a.tags, vec!["rust".to_string()]);
        assert_eq!(by_rel("documents/CLAUDE.md").expect("reusable CLAUDE.md present").kind, "reusable");
        let ds = by_rel("documents/.claude/settings.json").expect("reusable settings present");
        assert_eq!(ds.kind, "reusable");
        assert_eq!(ds.title, "settings.json");

        // Project.
        let g = by_rel("projects/proj-x/goal.md").expect("project section present");
        assert_eq!(g.kind, "project");
        assert_eq!(g.project.as_deref(), Some("proj-x"));
        assert_eq!(g.repo, None);
        assert_eq!(g.title, "goal"); // stem fallback
        assert_eq!(by_rel("projects/proj-x/prompts/kickoff.md").expect("project prompt present").kind, "project");
        assert_eq!(by_rel("projects/proj-x/.claude/settings.json").expect("project settings present").kind, "project");

        // Repo: only managed files, one DocInfo each, project + repo set.
        let rc = by_rel("projects/proj-x/api/CLAUDE.md").expect("repo CLAUDE.md present");
        assert_eq!(rc.kind, "repo");
        assert_eq!(rc.project.as_deref(), Some("proj-x"));
        assert_eq!(rc.repo.as_deref(), Some("api"));
        assert!(by_rel("projects/proj-x/api/CLAUDE.local.md").is_some(), "repo CLAUDE.local.md present");
        assert!(by_rel("projects/proj-x/api/.claude/settings.json").is_some(), "repo settings present");

        // The clone's own source files are NOT listed.
        assert!(by_rel("projects/proj-x/api/README.md").is_none(), "clone README must not be listed");
        assert!(by_rel("projects/proj-x/api/src/deep.md").is_none(), "clone source must not be listed");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn write_document_round_trips_and_rejects_traversal() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home = temp_home("writedoc");
        let base = bsc_base_dir();

        // Round-trip: write under documents/, read it back, parent dirs created.
        tauri::async_runtime::block_on(write_document(
            "documents/new-note.md".to_string(),
            "hello world".to_string(),
        )).expect("write succeeds");
        assert!(base.join("documents").join("new-note.md").exists(), "file created");
        let got = tauri::async_runtime::block_on(
            read_document("documents/new-note.md".to_string())
        ).expect("read succeeds");
        assert_eq!(got, "hello world");

        // Writing under projects/ also works (creates parent dirs).
        tauri::async_runtime::block_on(write_document(
            "projects/p1/goal.md".to_string(),
            "the goal".to_string(),
        )).expect("project write succeeds");
        assert!(base.join("projects").join("p1").join("goal.md").exists());

        // Traversal is rejected.
        assert!(tauri::async_runtime::block_on(write_document(
            "documents/../secret.md".to_string(), "x".to_string(),
        )).is_err(), "`..` rejected on write");
        assert!(tauri::async_runtime::block_on(
            read_document("documents/../secret.md".to_string())
        ).is_err(), "`..` rejected on read");

        // Out-of-store roots are rejected.
        assert!(tauri::async_runtime::block_on(write_document(
            "repos/x.md".to_string(), "x".to_string(),
        )).is_err(), "non documents/projects root rejected");

        // Absolute paths are rejected.
        assert!(tauri::async_runtime::block_on(write_document(
            "/etc/passwd".to_string(), "x".to_string(),
        )).is_err(), "absolute path rejected");

        std::fs::remove_dir_all(&home).ok();
    }
}
