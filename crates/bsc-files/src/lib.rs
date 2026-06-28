//! `bsc-files` core — gitignore-aware folder/tree structure with file **metrics**, plus single-path
//! `stat`. Pure logic (no CLI, no Tauri) so it's unit-testable and reusable; the binary in
//! `src/bin/bsc-files.rs` is a thin arg-parsing shell over this.
//!
//! Design notes:
//! - The walk uses the `ignore` crate, so `.gitignore`/`.ignore` are respected and `node_modules`,
//!   `target`, `dist`, hidden dirs, and `.git` fall out for free (with `--all` to override). Symlinks
//!   are never followed (closes the junction-traversal hazard the app's own walker guards, #1650).
//! - A directory node's `size`/`files` are the **aggregate** of everything under it, computed
//!   bottom-up — so `tree --depth 1` still reports accurate totals for collapsed subtrees.

use serde::Serialize;
use std::path::Path;

/// Whether a node is a directory or a file (serialized lowercase as the JSON `"type"`).
#[derive(Serialize, PartialEq, Eq, Clone, Copy, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Dir,
    File,
}

/// One node in the folder tree. For a file, `size` is its byte length and `files` is 1; for a
/// directory, both are the aggregate over its subtree. `lines`/`lang` are file-only and optional.
#[derive(Serialize, Debug)]
pub struct Node {
    pub name: String,
    /// Path relative to the tree root, forward-slash normalized ("" for the root itself).
    pub path: String,
    #[serde(rename = "type")]
    pub kind: Kind,
    /// Bytes — own size for a file, aggregate for a directory.
    pub size: u64,
    /// File count — 1 for a file, aggregate for a directory.
    pub files: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<Node>,
}

impl Node {
    fn dir(name: String, path: String) -> Node {
        Node { name, path, kind: Kind::Dir, size: 0, files: 0, lines: None, lang: None, children: Vec::new() }
    }
}

/// Single-path metrics (the `stat` command).
#[derive(Serialize, Debug)]
pub struct FileStat {
    pub path: String,
    #[serde(rename = "type")]
    pub kind: Kind,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    /// Last-modified time as a Unix epoch (seconds), when the platform reports it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_epoch: Option<u64>,
}

impl FileStat {
    /// Human one-liner: `<type>  <size>  <lang>[, <n> lines]`.
    pub fn lean(&self) -> String {
        let mut s = format!("{}  {}", if self.kind == Kind::Dir { "dir" } else { "file" }, human_size(self.size));
        if let Some(l) = &self.lang {
            s.push_str(&format!("  {l}"));
        }
        if let Some(n) = self.lines {
            s.push_str(&format!(", {n} lines"));
        }
        s
    }
}

/// What to include when walking (mirrors the CLI flags).
#[derive(Default, Clone, Copy)]
pub struct TreeOpts {
    /// Include gitignored + hidden entries (the `ignore` filters are turned off).
    pub include_all: bool,
    /// Include dotfiles/dot-dirs but still honor .gitignore.
    pub include_hidden: bool,
    /// Compute per-file line counts (reads each text file — slower).
    pub count_lines: bool,
}

/// Format a byte count as a short human string (`512 B`, `1.4 KB`, `3.2 MB`, …). Binary units.
pub fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut f = bytes as f64;
    let mut i = 0;
    while f >= 1024.0 && i < UNITS.len() - 1 {
        f /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{bytes} B")
    } else {
        format!("{f:.1} {}", UNITS[i])
    }
}

/// The language label for a path by extension, or None for an unrecognized/extensionless file.
pub fn lang_for(path: &str) -> Option<String> {
    let ext = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    let lang = match ext.as_str() {
        "rs" => "rust",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "jsx",
        "json" => "json",
        "md" | "markdown" => "markdown",
        "toml" => "toml",
        "css" => "css",
        "scss" | "sass" => "scss",
        "html" | "htm" => "html",
        "py" => "python",
        "sh" | "bash" => "shell",
        "yml" | "yaml" => "yaml",
        "sql" => "sql",
        "go" => "go",
        _ => return None,
    };
    Some(lang.to_string())
}

/// Line count of a UTF-8 text file; None for a binary/unreadable file (so it's simply omitted).
fn count_lines_of(path: &Path) -> Option<u64> {
    std::fs::read_to_string(path).ok().map(|s| s.lines().count() as u64)
}

/// Build the folder tree under `root` with per-file metrics and bottom-up directory aggregates.
/// Honors `opts` (gitignore/hidden/line-counts). Errors only if `root` can't be walked at all.
pub fn build_tree(root: &Path, opts: &TreeOpts) -> Result<Node, String> {
    let root_name = root
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.to_string_lossy().into_owned());
    let mut tree = Node::dir(root_name, String::new());

    let walker = ignore::WalkBuilder::new(root)
        .hidden(!(opts.include_hidden || opts.include_all)) // skip dotfiles unless asked
        .git_ignore(!opts.include_all)
        .git_global(!opts.include_all)
        .git_exclude(!opts.include_all)
        .ignore(!opts.include_all)
        .parents(!opts.include_all)
        // Honor .gitignore even when the dir isn't a git repo (a sub-worktree, or a standalone run on
        // a non-git folder) — otherwise the `ignore` crate only applies it inside a `.git` repo.
        .require_git(false)
        .follow_links(false)
        .build();

    for result in walker {
        let entry = match result {
            Ok(e) => e,
            Err(_) => continue, // an unreadable entry is skipped, not fatal
        };
        if entry.depth() == 0 {
            continue; // the root itself; its children populate the tree
        }
        let rel = match entry.path().strip_prefix(root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if rel.is_empty() {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let size = if is_dir { 0 } else { entry.metadata().map(|m| m.len()).unwrap_or(0) };
        let lines = if !is_dir && opts.count_lines { count_lines_of(entry.path()) } else { None };
        let lang = if is_dir { None } else { lang_for(&rel) };
        let comps: Vec<&str> = rel.split('/').collect();
        insert(&mut tree, &comps, is_dir, size, lines, lang);
    }

    aggregate(&mut tree);
    Ok(tree)
}

/// Insert one walked entry into the tree, creating intermediate directory nodes as needed. A file
/// or directory whose node was already created (as a parent of an earlier-seen descendant) is filled
/// in rather than duplicated.
fn insert(parent: &mut Node, comps: &[&str], is_dir: bool, size: u64, lines: Option<u64>, lang: Option<String>) {
    let name = comps[0];
    let child_path = if parent.path.is_empty() { name.to_string() } else { format!("{}/{}", parent.path, name) };

    if comps.len() == 1 {
        // Leaf entry. If a placeholder dir node already exists (created by a deeper descendant), only
        // a FILE leaf needs to overwrite it; a dir leaf is already correct.
        if let Some(existing) = parent.children.iter_mut().find(|c| c.name == name) {
            if !is_dir {
                existing.kind = Kind::File;
                existing.size = size;
                existing.lines = lines;
                existing.lang = lang;
            }
            return;
        }
        parent.children.push(Node {
            name: name.to_string(),
            path: child_path,
            kind: if is_dir { Kind::Dir } else { Kind::File },
            size,
            files: 0,
            lines,
            lang,
            children: Vec::new(),
        });
        return;
    }

    // Intermediate directory: find or create it, then recurse.
    let idx = match parent.children.iter().position(|c| c.name == name) {
        Some(i) => i,
        None => {
            parent.children.push(Node::dir(name.to_string(), child_path));
            parent.children.len() - 1
        }
    };
    insert(&mut parent.children[idx], &comps[1..], is_dir, size, lines, lang);
}

/// Sort children (directories first, then files, each alphabetical) and roll up directory
/// `size`/`files` from the leaves. Returns this node's `(size, files)`.
fn aggregate(node: &mut Node) -> (u64, u64) {
    if node.kind == Kind::File {
        node.files = 1;
        return (node.size, 1);
    }
    node.children.sort_by(|a, b| {
        (a.kind == Kind::File).cmp(&(b.kind == Kind::File)).then_with(|| a.name.cmp(&b.name))
    });
    let (mut size, mut files) = (0u64, 0u64);
    for child in &mut node.children {
        let (s, f) = aggregate(child);
        size += s;
        files += f;
    }
    node.size = size;
    node.files = files;
    (size, files)
}

/// Render the tree as indented human text with sizes — directories as `name/  (<size>, <n> files)`,
/// files as `name  <size>[, <n> lines]`. `max_depth` collapses deeper subtrees (their aggregate is
/// still shown on the directory line). Two-space indent per level; easy for both humans and a model.
pub fn render_tree(node: &Node, max_depth: Option<usize>) -> String {
    let mut out = String::new();
    render_node(node, 0, max_depth, &mut out);
    out
}

fn render_node(node: &Node, depth: usize, max_depth: Option<usize>, out: &mut String) {
    let indent = "  ".repeat(depth);
    match node.kind {
        Kind::Dir => {
            out.push_str(&format!("{indent}{}/  ({}, {} files)\n", node.name, human_size(node.size), node.files));
            if max_depth.is_none_or(|m| depth < m) {
                for child in &node.children {
                    render_node(child, depth + 1, max_depth, out);
                }
            }
        }
        Kind::File => {
            let extra = node.lines.map(|n| format!(", {n} lines")).unwrap_or_default();
            out.push_str(&format!("{indent}{}  {}{}\n", node.name, human_size(node.size), extra));
        }
    }
}

/// Metrics for a single path (the `stat` command). Errors if the path doesn't exist.
pub fn stat(path: &Path, count_lines: bool) -> Result<FileStat, String> {
    let md = std::fs::metadata(path).map_err(|e| format!("stat {}: {e}", path.display()))?;
    let is_dir = md.is_dir();
    let display = path.to_string_lossy().replace('\\', "/");
    let modified_epoch = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    Ok(FileStat {
        path: display.clone(),
        kind: if is_dir { Kind::Dir } else { Kind::File },
        size: if is_dir { 0 } else { md.len() },
        lines: if !is_dir && count_lines { count_lines_of(path) } else { None },
        lang: if is_dir { None } else { lang_for(&display) },
        modified_epoch,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("bsc-files-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn human_size_scales_units() {
        assert_eq!(human_size(0), "0 B");
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(1024), "1.0 KB");
        assert_eq!(human_size(1536), "1.5 KB");
        assert_eq!(human_size(1024 * 1024), "1.0 MB");
    }

    #[test]
    fn lang_for_maps_known_extensions_only() {
        assert_eq!(lang_for("src/main.rs").as_deref(), Some("rust"));
        assert_eq!(lang_for("a/b.tsx").as_deref(), Some("tsx"));
        assert_eq!(lang_for("Cargo.toml").as_deref(), Some("toml"));
        assert_eq!(lang_for("README"), None); // no extension
        assert_eq!(lang_for("blob.bin"), None); // unknown
    }

    #[test]
    fn build_tree_nests_sizes_counts_and_aggregates() {
        let root = scratch("tree");
        fs::create_dir_all(root.join("src/sub")).unwrap();
        fs::write(root.join("Cargo.toml"), "name=x").unwrap(); // 6 bytes
        fs::write(root.join("src/lib.rs"), "fn a() {}\nfn b() {}\n").unwrap(); // 20 bytes, 2 lines
        fs::write(root.join("src/sub/deep.rs"), "x").unwrap(); // 1 byte

        let tree = build_tree(&root, &TreeOpts { count_lines: true, ..Default::default() }).unwrap();
        // Root aggregates everything: 3 files, 6 + 20 + 1 = 27 bytes.
        assert_eq!(tree.kind, Kind::Dir);
        assert_eq!(tree.files, 3);
        assert_eq!(tree.size, 27);

        // Directories sort before files: src/ then Cargo.toml.
        assert_eq!(tree.children[0].name, "src");
        assert_eq!(tree.children[0].kind, Kind::Dir);
        assert_eq!(tree.children[1].name, "Cargo.toml");

        // src/ aggregates its subtree: lib.rs (20) + sub/deep.rs (1) = 21 bytes, 2 files.
        let src = &tree.children[0];
        assert_eq!(src.size, 21);
        assert_eq!(src.files, 2);

        // The leaf carries its own size + line count + language.
        let lib = src.children.iter().find(|c| c.name == "lib.rs").unwrap();
        assert_eq!(lib.size, 20);
        assert_eq!(lib.lines, Some(2));
        assert_eq!(lib.lang.as_deref(), Some("rust"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn build_tree_respects_gitignore_and_all_override() {
        let root = scratch("ignore");
        fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
        fs::create_dir_all(root.join("ignored")).unwrap();
        fs::write(root.join("ignored/secret.rs"), "x").unwrap();
        fs::write(root.join("kept.rs"), "y").unwrap();

        // Default: the gitignored dir is absent.
        let tree = build_tree(&root, &TreeOpts::default()).unwrap();
        assert!(tree.children.iter().all(|c| c.name != "ignored"), "ignored/ must be skipped");
        assert!(tree.children.iter().any(|c| c.name == "kept.rs"));

        // --all includes it.
        let all = build_tree(&root, &TreeOpts { include_all: true, ..Default::default() }).unwrap();
        assert!(all.children.iter().any(|c| c.name == "ignored"), "--all includes gitignored");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn render_tree_indents_and_collapses_at_max_depth() {
        let root = scratch("render");
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::write(root.join("a/b/c.rs"), "x").unwrap();
        let tree = build_tree(&root, &TreeOpts::default()).unwrap();

        // Full render reaches the leaf.
        let full = render_tree(&tree, None);
        assert!(full.contains("a/"));
        assert!(full.contains("c.rs"));

        // Depth 1 shows `a/` (with its aggregate) but not the nested file.
        let shallow = render_tree(&tree, Some(1));
        assert!(shallow.contains("a/  ("));
        assert!(!shallow.contains("c.rs"), "deeper than max_depth is collapsed");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stat_reports_size_lang_and_lines() {
        let root = scratch("stat");
        fs::write(root.join("f.ts"), "const a = 1;\nconst b = 2;\n").unwrap();
        let s = stat(&root.join("f.ts"), true).unwrap();
        assert_eq!(s.kind, Kind::File);
        assert_eq!(s.size, 26); // "const a = 1;\n" (13) + "const b = 2;\n" (13)
        assert_eq!(s.lines, Some(2));
        assert_eq!(s.lang.as_deref(), Some("typescript"));
        assert!(s.lean().contains("typescript"));
        // A missing path is a clean Err, not a panic.
        assert!(stat(&root.join("nope"), false).is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
