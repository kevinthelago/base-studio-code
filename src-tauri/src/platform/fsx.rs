//! Small filesystem utilities (#1300) — project-key sanitization, path-escape guarding, recursive
//! text-file reads, and plan section-file ingestion. Pure-ish helpers shared across domains.
//! Extracted verbatim from `lib.rs`.

/// Map a string to a filesystem-safe slug: every char for which `allow` is true is kept as-is,
/// every other char is replaced by `fill`; when `cap` is `Some(n)` the result is truncated to the
/// first `n` chars. This is the single char-map primitive the Family-A slug helpers delegate to
/// (#1663) — each named wrapper supplies its own allowed-char set / fill / cap so its byte-exact
/// semantics are preserved.
pub(crate) fn map_slug(s: &str, allow: impl Fn(char) -> bool, fill: char, cap: Option<usize>) -> String {
    let mapped = s.chars().map(|c| if allow(c) { c } else { fill });
    match cap {
        Some(n) => mapped.take(n).collect(),
        None => mapped.collect(),
    }
}

/// Slugify `name` into a single safe directory segment: keep every char `allow` accepts, replace the
/// rest with `_`, and reject the result if it is empty, `.`, or `..` (so it can never escape its
/// parent dir). The shared empty/`.`/`..` guard behind [`crate::extensions::mcp::mcp_install_dir`]
/// (#1663). (The blueprint store's slug guard now lives in the `bsc-blueprint` crate, #1761.)
/// `Err` carries a generic reason; callers map it to their own message.
pub(crate) fn safe_dir_segment(name: &str, allow: impl Fn(char) -> bool) -> Result<String, String> {
    let safe = map_slug(name, allow, '_', None);
    if safe.is_empty() || safe == "." || safe == ".." {
        return Err("invalid directory segment".into());
    }
    Ok(safe)
}

/// Sanitize a project key into a filesystem-safe slug.
///
/// Must stay byte-for-byte identical to the frontend's paneId sanitization in
/// Planning.tsx (`replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 80)`) so the PTY id and
/// the planning directory always correspond. ASCII-only on purpose — Rust's
/// `char::is_alphanumeric` accepts Unicode letters, which the JS regex does not.
pub(crate) fn sanitize_project_key(key: &str) -> String {
    // keep [A-Za-z0-9-] → '_', cap 80 (delegates to map_slug; semantics frozen).
    map_slug(key, |c| c.is_ascii_alphanumeric() || c == '-', '_', Some(80))
}

/// Slugify a worktree/branch reference: keep `[A-Za-z0-9._-]`, every other char becomes `-`.
///
/// Must stay identical to the frontend `worktreeSlug` AND be the single source of truth on the Rust
/// side — the fleet uses it to *create* a worktree's on-disk path while session discovery uses it to
/// *recompute* that path; if the two ever diverged, recovery would miss live worktrees (#1300).
pub(crate) fn worktree_slug(s: &str) -> String {
    // keep [A-Za-z0-9._-] → '-', no cap (delegates to map_slug; semantics frozen).
    map_slug(s, |c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-', '-', None)
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

/// Recursively read every text file under `root` for which `accept(path)` is true, as
/// `(relpath → contents)` pairs — capped at 512 KiB each, skipping unreadable/binary files.
/// relpaths are forward-slashed and relative to `root`; the result is sorted by relpath.
///
/// This is the one shared walker behind [`read_files_dir`] (accept-all) and
/// `ui_skeleton::read_skeleton_dir` (extension-filtered) — the size cap, slash-normalize, and sort
/// live here in one place. **Symlinks and junctions are skipped** (never recursed into or read):
/// each entry's `symlink_metadata().file_type().is_symlink()` is checked first, closing the
/// node_modules junction-traversal hazard (#1650).
pub(crate) fn read_text_files(root: &std::path::Path, accept: impl Fn(&std::path::Path) -> bool) -> Vec<(String, String)> {
    fn walk(base: &std::path::Path, dir: &std::path::Path, accept: &dyn Fn(&std::path::Path) -> bool, out: &mut Vec<(String, String)>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            // Skip symlinks/junctions outright: never recurse into them, never read them (#1650).
            let Ok(meta) = std::fs::symlink_metadata(&p) else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                walk(base, &p, accept, out);
            } else if accept(&p) && meta.len() <= 512 * 1024 {
                if let (Ok(rel), Ok(content)) = (p.strip_prefix(base), std::fs::read_to_string(&p)) {
                    out.push((rel.to_string_lossy().replace('\\', "/"), content));
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &accept, &mut out);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Recursively read every (text) file under `root` as `(relpath → contents)`, capped at
/// 512 KiB each, skipping unreadable/binary files. relpaths are forward-slashed and
/// relative to `root`. The generic complement to `read_skeleton_dir` (which filters by
/// extension) — pipelines persist arbitrary file types (`.vue`, `.svg`, `.html`, …).
/// Delegates to [`read_text_files`] (accept-all).
pub(crate) fn read_files_dir(root: &std::path::Path) -> Vec<(String, String)> {
    read_text_files(root, |_| true)
}

/// Ingest every non-empty `.md`/`.json` section file in `dir` (top level only), keyed by
/// file stem, into `sections` — skipping the workspace control files. Used to read the hub
/// root + the `context/` subdir; a later call overrides earlier keys (context/ wins, #807).
pub(crate) fn ingest_section_files(dir: &std::path::Path, sections: &mut std::collections::HashMap<String, String>) {
    // Workspace control files plus the DB-owned `fleet.json` (#1805): the fleet lives solely in
    // plan.db now, so a stray legacy `fleet.json` must never be ingested as a plan section (it is
    // migrated into plan.db then deleted on the first fleet read — see `migrate_stray_fleet_json`).
    const CONTROL: &[&str] = &["CLAUDE.md", "automations.md", "extensions.md", "github_context.md", "fleet.json"];
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

/// Atomically write `bytes` to `path`: write a sibling temp file, then rename over the
/// target (atomic on the same volume). A direct `fs::write` can be observed half-written or
/// interleaved with another process's write — the failure mode that left trailing bytes after
/// valid JSON and corrupted `~/.claude.json` when many sessions launched at once (#1683). The
/// single atomic writer shared by every config writer (`~/.claude.json`, `.claude/settings.json`,
/// `.mcp.json`, `CLAUDE.md`). The parent directory must already exist.
pub(crate) fn atomic_write(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp);
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

/// Pretty-serialize `value` and [`atomic_write`] it to `path`. Produces exactly the bytes
/// `serde_json::to_string_pretty` does (no trailing newline) so routing a writer through this
/// helper does not churn the on-disk file. A serialization failure surfaces as an `io::Error`.
pub(crate) fn atomic_write_json(path: &std::path::Path, value: &serde_json::Value) -> std::io::Result<()> {
    let s = serde_json::to_string_pretty(value).map_err(std::io::Error::other)?;
    atomic_write(path, s.as_bytes())
}

/// Read `path` and parse it as JSON, coercing the result to a JSON object: a missing/unreadable
/// file, unparseable contents, or a non-object value (array/string/number/null) all yield an
/// empty object `{}`. The shared replacement for the read-or-default-then-`if !is_object`
/// idiom the config writers used to inline before a read-modify-write (#1683).
pub(crate) fn read_json_object_or_default(path: &std::path::Path) -> serde_json::Value {
    let mut v: serde_json::Value = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    ensure_object(&mut v);
    v
}

/// Coerce `v` to a JSON object in place: if it is not already an object (array, scalar, null),
/// replace it with an empty object `{}`. Absorbs the `if !x.is_object() { *x = json!({}) }`
/// guard the config writers repeat before treating a nested value as a map (#1683).
pub(crate) fn ensure_object(v: &mut serde_json::Value) {
    if !v.is_object() {
        *v = serde_json::json!({});
    }
}

/// Recursively clear the read-only attribute on every file under `dir`. Best-effort:
/// unreadable entries are skipped. Needed so `remove_dir_all` can delete cloned-repo dirs
/// (git's pack files are read-only) on Windows. Windows-only: on Unix `remove_dir_all`
/// deletes regardless of file perms, and `set_readonly(false)` would loosen the mode there.
#[cfg(windows)]
#[allow(clippy::permissions_set_readonly_false)] // clearing the RO attribute IS the intent on Windows
pub(crate) fn clear_readonly_recursive(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => clear_readonly_recursive(&path),
            Ok(_) => {
                if let Ok(meta) = entry.metadata() {
                    let mut perms = meta.permissions();
                    if perms.readonly() {
                        perms.set_readonly(false);
                        let _ = std::fs::set_permissions(&path, perms);
                    }
                }
            }
            Err(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// Create a directory symlink/junction `link` → `target`, returning whether it succeeded.
    /// On Windows a directory *junction* (`mklink /J`) needs no elevation but can still be denied
    /// in locked-down environments — the caller skips the test when this returns `false`.
    fn try_link_dir(target: &Path, link: &Path) -> bool {
        #[cfg(windows)]
        {
            let mut mk = std::process::Command::new("cmd");
            mk.args(["/c", "mklink", "/J", &link.to_string_lossy(), &target.to_string_lossy()]);
            crate::no_window(&mut mk).status().map(|s| s.success()).unwrap_or(false)
        }
        #[cfg(not(windows))]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }

    /// A unique scratch path under the OS temp dir (no file created).
    fn scratch_path(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "bsc_fsx_{tag}_{}_{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0),
        ))
    }

    #[test]
    fn atomic_write_json_roundtrips_through_read_json_object_or_default() {
        let path = scratch_path("roundtrip").with_extension("json");
        let _ = std::fs::remove_file(&path);

        let value = serde_json::json!({
            "permissions": { "allow": ["Bash(git *)"], "deny": [] },
            "n": 7,
            "nested": { "a": [1, 2, 3] }
        });
        atomic_write_json(&path, &value).unwrap();

        // On-disk bytes are exactly to_string_pretty (no trailing newline) so files don't churn.
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert_eq!(on_disk, serde_json::to_string_pretty(&value).unwrap());

        // Round-trips back to the same value as an object.
        let read_back = read_json_object_or_default(&path);
        assert_eq!(read_back, value);

        // No leftover temp sibling after the rename.
        assert!(!path.with_extension("json.tmp").exists());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_json_object_or_default_defaults_for_missing_unparseable_and_non_object() {
        let empty = serde_json::json!({});

        // Missing file → {}.
        let missing = scratch_path("missing").with_extension("json");
        let _ = std::fs::remove_file(&missing);
        assert_eq!(read_json_object_or_default(&missing), empty);

        // Unparseable contents → {}.
        let junk = scratch_path("junk").with_extension("json");
        std::fs::write(&junk, "not json at all").unwrap();
        assert_eq!(read_json_object_or_default(&junk), empty);

        // A valid but non-object value (array) → {}.
        let arr = scratch_path("arr").with_extension("json");
        std::fs::write(&arr, "[1, 2, 3]").unwrap();
        assert_eq!(read_json_object_or_default(&arr), empty);

        for p in [&junk, &arr] { let _ = std::fs::remove_file(p); }
    }

    #[test]
    fn ensure_object_coerces_non_objects_and_preserves_objects() {
        let mut arr = serde_json::json!([1, 2]);
        ensure_object(&mut arr);
        assert_eq!(arr, serde_json::json!({}));

        let mut scalar = serde_json::json!(5);
        ensure_object(&mut scalar);
        assert_eq!(scalar, serde_json::json!({}));

        let mut obj = serde_json::json!({ "keep": true });
        ensure_object(&mut obj);
        assert_eq!(obj, serde_json::json!({ "keep": true }));
    }

    #[test]
    fn ingest_section_files_skips_fleet_json_and_control_files() {
        use std::fs;
        let dir = scratch_path("ingest");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // A real section file is ingested by its stem; the DB-owned `fleet.json` and the workspace
        // control files are skipped (#1805) so a stray fleet.json never surfaces as a plan section.
        fs::write(dir.join("goal.md"), "the goal").unwrap();
        fs::write(dir.join("fleet.json"), r#"{"streams":[{"id":"x","repo":"o/r"}]}"#).unwrap();
        fs::write(dir.join("CLAUDE.md"), "spec").unwrap();

        let mut sections = std::collections::HashMap::new();
        ingest_section_files(&dir, &mut sections);

        assert_eq!(sections.get("goal").map(String::as_str), Some("the goal"));
        assert!(!sections.contains_key("fleet"), "stray fleet.json is excluded from the sweep");
        assert!(!sections.contains_key("CLAUDE"), "control files are excluded");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_text_files_skips_symlinked_dirs_and_files() {
        use std::fs;
        let root = std::env::temp_dir().join(format!(
            "bsc_fsx_symlink_{}_{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0),
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("real")).unwrap();
        fs::write(root.join("top.txt"), "top").unwrap();
        fs::write(root.join("real").join("keep.txt"), "real content").unwrap();

        // A symlinked/junctioned dir pointing at `real`; if the platform denies link creation
        // (e.g. no privilege), skip gracefully rather than fail.
        let linkdir = root.join("linkdir");
        if !try_link_dir(&root.join("real"), &linkdir) {
            let _ = fs::remove_dir_all(&root);
            return;
        }

        // A symlinked *file* too, when the platform supports it without elevation (Unix). Its
        // skip is asserted only when actually created.
        #[cfg(not(windows))]
        let linked_file_created = std::os::unix::fs::symlink(root.join("real").join("keep.txt"), root.join("link.txt")).is_ok();
        #[cfg(windows)]
        let linked_file_created = false;

        let keys: Vec<String> = read_text_files(&root, |_| true).into_iter().map(|(k, _)| k).collect();

        // Real files are read.
        assert!(keys.contains(&"top.txt".to_string()), "real top-level file read: {keys:?}");
        assert!(keys.contains(&"real/keep.txt".to_string()), "real nested file read: {keys:?}");
        // The symlinked dir is never recursed into.
        assert!(!keys.iter().any(|k| k.starts_with("linkdir")), "symlinked dir skipped: {keys:?}");
        // The symlinked file (when created) is never read.
        if linked_file_created {
            assert!(!keys.iter().any(|k| k == "link.txt"), "symlinked file skipped: {keys:?}");
        }

        let _ = fs::remove_dir_all(&root);
    }

    /// On Windows, `clear_readonly_recursive` strips the read-only attribute from every file in the
    /// tree (including nested ones) so `remove_dir_all` can later delete read-only git packs (#793).
    #[cfg(windows)]
    #[test]
    fn clear_readonly_recursive_clears_nested_readonly_files() {
        use std::fs;
        let root = scratch_path("readonly");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("nested")).unwrap();
        let top = root.join("top.txt");
        let deep = root.join("nested").join("deep.txt");
        fs::write(&top, "top").unwrap();
        fs::write(&deep, "deep").unwrap();

        // Mark both files read-only.
        for p in [&top, &deep] {
            let mut perms = fs::metadata(p).unwrap().permissions();
            perms.set_readonly(true);
            fs::set_permissions(p, perms).unwrap();
        }
        assert!(fs::metadata(&top).unwrap().permissions().readonly());
        assert!(fs::metadata(&deep).unwrap().permissions().readonly());

        clear_readonly_recursive(&root);

        assert!(!fs::metadata(&top).unwrap().permissions().readonly(), "top-level RO cleared");
        assert!(!fs::metadata(&deep).unwrap().permissions().readonly(), "nested RO cleared");

        let _ = fs::remove_dir_all(&root);
    }
}
